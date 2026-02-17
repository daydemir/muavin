import { readFile, readdir, mkdir, unlink, stat } from "fs/promises";
import { join } from "path";
import { MUAVIN_DIR, loadJson, saveJson, timeAgo, timestamp } from "./utils";
import type { Job } from "./jobs";

const AGENTS_DIR = join(MUAVIN_DIR, "agents");
const SUPABASE_TIMEOUT_MS = 30_000;
const WORKER_PATH = join(import.meta.dir, "memory-worker.ts");
const BUN_PATH = process.execPath;

async function spawnWorker<T>(command: string, input: object): Promise<T> {
  const proc = Bun.spawn([BUN_PATH, "run", WORKER_PATH, command], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: process.env,
    cwd: MUAVIN_DIR,
  });
  proc.stdin.write(JSON.stringify(input));
  proc.stdin.end();

  const timeout = setTimeout(() => proc.kill(), SUPABASE_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`memory-worker ${command} failed: ${stderr}`);
    return JSON.parse(stdout) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export interface AgentFile {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  task: string;
  prompt: string;
  chatId: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastStatusAt?: string;
  result?: string;
  deliveredResult?: string;
  error?: string;
  pid?: number;
  model?: string;
  _filename?: string;
}

export async function createAgent(opts: {
  task: string;
  prompt: string;
  chatId: number;
  model?: string;
}): Promise<AgentFile> {
  await mkdir(AGENTS_DIR, { recursive: true });

  const id = `a_${Date.now()}`;
  const agent: AgentFile = {
    id,
    status: "pending",
    task: opts.task,
    prompt: opts.prompt,
    chatId: opts.chatId,
    createdAt: new Date().toISOString(),
    ...(opts.model && { model: opts.model }),
  };

  const filePath = join(AGENTS_DIR, `${id}.json`);
  await saveJson(filePath, agent);

  return agent;
}

export async function getAgent(id: string): Promise<AgentFile | null> {
  try {
    const filePath = join(AGENTS_DIR, `${id}.json`);
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

const writeLocks = new Map<string, Promise<void>>();

export async function updateAgent(
  id: string,
  updates: Partial<AgentFile>,
  filename?: string,
): Promise<void> {
  const key = filename ?? `${id}.json`;
  const prev = writeLocks.get(key) ?? Promise.resolve();
  const current = prev.then(async () => {
    const filePath = join(AGENTS_DIR, key);
    const data = JSON.parse(await readFile(filePath, "utf-8")) as AgentFile;
    const { _filename, ...rest } = { ...data, ...updates };
    await saveJson(filePath, rest);
  });
  const wrapped = current.catch((e) => {
    console.error(timestamp("agents"), `updateAgent write failed for ${key}:`, e);
  });
  writeLocks.set(key, wrapped);
  wrapped.finally(() => {
    if (writeLocks.get(key) === wrapped) writeLocks.delete(key);
  });
  await current;
}

export async function listAgents(filter?: {
  status?: AgentFile["status"];
}): Promise<AgentFile[]> {
  try {
    await mkdir(AGENTS_DIR, { recursive: true });
    const files = await readdir(AGENTS_DIR);
    const agents: AgentFile[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const content = await readFile(join(AGENTS_DIR, file), "utf-8");
        const agent: AgentFile = JSON.parse(content);
        agent._filename = file;

        if (filter?.status && agent.status !== filter.status) continue;

        agents.push(agent);
      } catch {
        // Skip malformed files
        continue;
      }
    }

    return agents.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  } catch {
    return [];
  }
}

export async function getAgentList(): Promise<string> {
  const agents = await listAgents();
  if (agents.length === 0) return "";

  const sorted = agents
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20);

  const lines: string[] = ["[Agents]"];

  for (const agent of sorted) {
    const ts = agent.completedAt ?? agent.startedAt ?? agent.createdAt;
    const ago = timeAgo(new Date(ts).getTime());
    lines.push(`${agent.status}: "${agent.task}" (${ago})`);
  }

  return lines.join("\n");
}

export async function getJobsSummary(): Promise<string> {
  const jobsPath = join(MUAVIN_DIR, "jobs.json");
  const jobStatePath = join(MUAVIN_DIR, "job-state.json");

  const lines: string[] = [];

  try {
    // Load all jobs from jobs.json
    const allJobs = await loadJson<Job[]>(jobsPath);

    if (!allJobs || allJobs.length === 0) return "";

    // Filter enabled jobs
    const jobs = allJobs.filter(j => j.enabled);

    // Load job state for last run times
    const jobState = await loadJson<Record<string, number>>(jobStatePath) ?? {};

    if (jobs.length === 0) return "";

    lines.push("[Active Jobs]");
    for (const job of jobs) {
      const lastRun = jobState[job.id];
      const lastRunStr = lastRun ? `last: ${timeAgo(lastRun)}` : "never run";
      const label = job.type === "system" ? `system, ${job.action ?? "custom prompt"}` : job.type === "default" ? "default" : "user";
      lines.push(`  ${job.name || job.id} (${label}) — ${job.schedule} — ${lastRunStr}`);
    }
  } catch {
    return "";
  }

  return lines.join("\n");
}

export async function buildContext(opts: {
  query: string;
  chatId?: number;
  recentCount?: number;
  full?: boolean;
}): Promise<string> {
  const full = opts.full !== false; // default true
  const parts: string[] = [];

  // 1. Read muavin.md (voice only)
  if (full) {
    try {
      const muavinMd = await readFile(join(MUAVIN_DIR, "muavin.md"), "utf-8");
      parts.push(muavinMd.trim());
    } catch {}
  }

  // 2 & 3. Semantic search + recent messages via subprocess (avoids bun connection pool issues)
  type SearchResult = Array<{ content: string; source: string; similarity: number }>;
  type RecentResult = Array<{ role: string; content: string; created_at: string }>;

  let searchFailed = false;
  let recentFailed = false;

  const [contextResults, recent] = await Promise.all([
    spawnWorker<SearchResult>("search", { query: opts.query, limit: 3 })
      .catch(e => { searchFailed = true; console.error("buildContext: search worker failed:", e.message); return [] as SearchResult; }),

    (full && opts.chatId && opts.recentCount)
      ? spawnWorker<RecentResult>("recent", { chatId: String(opts.chatId), limit: opts.recentCount })
          .catch(e => { recentFailed = true; console.error("buildContext: recent worker failed:", e.message); return [] as RecentResult; })
      : Promise.resolve([] as RecentResult),
  ]);

  if (searchFailed || recentFailed) {
    const missing = [
      searchFailed && "memory search",
      recentFailed && "recent messages",
    ].filter(Boolean).join(" and ");
    parts.push(`[System Warning] ${missing} failed — you are responding without full context.`);
  }

  if (contextResults.length > 0) {
    const contextStr = contextResults
      .map((r) => `[${r.source}] ${r.content}`)
      .join("\n");
    parts.push(`[Memory]\n${contextStr}`);
  }

  if (recent.length > 0) {
    const recentStr = recent
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    parts.push(`[Recent Messages]\n${recentStr}`);
  }

  // 4. Agent summary (voice only)
  if (full) {
    const agentList = await getAgentList();
    if (agentList) parts.push(agentList);
  }

  // 5. Jobs summary (voice only)
  if (full) {
    const jobsSummary = await getJobsSummary();
    if (jobsSummary) parts.push(jobsSummary);
  }

  return parts.join("\n\n");
}

export async function cleanupAgents(maxAgeMs: number): Promise<number> {
  const agents = await listAgents();
  const now = Date.now();
  let deleted = 0;

  const terminal = agents
    .filter(a => a.status === "completed" || a.status === "failed")
    .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime());

  for (const agent of terminal) {
    const timestamp = agent.completedAt ?? agent.createdAt;
    const age = now - new Date(timestamp).getTime();
    const overCap = (terminal.length - deleted) > 100;

    if (age > maxAgeMs || overCap) {
      try {
        await unlink(join(AGENTS_DIR, agent._filename ?? `${agent.id}.json`));
        deleted++;
      } catch {
        continue;
      }
    }
  }

  return deleted;
}

export async function cleanupUploads(maxAgeMs: number): Promise<number> {
  const uploadsDir = join(MUAVIN_DIR, "uploads");
  await mkdir(uploadsDir, { recursive: true });

  const files = await readdir(uploadsDir);
  const now = Date.now();
  let deleted = 0;

  for (const file of files) {
    const filePath = join(uploadsDir, file);
    try {
      const { mtimeMs } = await stat(filePath);
      if (now - mtimeMs > maxAgeMs) {
        await unlink(filePath);
        deleted++;
      }
    } catch {
      continue;
    }
  }

  return deleted;
}

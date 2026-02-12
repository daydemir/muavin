import { readFile, writeFile, readdir, mkdir, unlink, rename, stat } from "fs/promises";
import { join } from "path";
import { MUAVIN_DIR, loadJson, timeAgo } from "./utils";
import type { Job } from "./jobs";

const AGENTS_DIR = join(MUAVIN_DIR, "agents");
const SUPABASE_TIMEOUT_MS = 15_000;

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
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(agent, null, 2));
  await rename(tmpPath, filePath);

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

export async function updateAgent(
  id: string,
  updates: Partial<AgentFile>,
  filename?: string,
): Promise<void> {
  const filePath = join(AGENTS_DIR, filename ?? `${id}.json`);
  const current = JSON.parse(await readFile(filePath, "utf-8")) as AgentFile;
  const { _filename, ...rest } = { ...current, ...updates };
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(rest, null, 2));
  await rename(tmpPath, filePath);
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

  // 2 & 3. Semantic search + recent messages in parallel (15s timeout each)
  const { searchContext, getRecentMessages } = await import("./memory");

  const searchAbort = new AbortController();
  const recentAbort = new AbortController();

  const [contextResults, recent] = await Promise.all([
    Promise.race([
      searchContext(opts.query, 3, searchAbort.signal),
      new Promise<[]>(resolve => setTimeout(() => {
        console.error("buildContext: Supabase search timed out (15s)");
        searchAbort.abort();
        resolve([]);
      }, SUPABASE_TIMEOUT_MS)),
    ]).catch(() => []),

    (full && opts.chatId && opts.recentCount)
      ? Promise.race([
          getRecentMessages(String(opts.chatId), opts.recentCount, recentAbort.signal),
          new Promise<[]>(resolve => setTimeout(() => {
            console.error("buildContext: recent messages timed out (15s)");
            recentAbort.abort();
            resolve([]);
          }, SUPABASE_TIMEOUT_MS)),
        ]).catch(() => [])
      : Promise.resolve([]),
  ]);

  if (searchAbort.signal.aborted || recentAbort.signal.aborted) {
    const missing = [
      searchAbort.signal.aborted && "memory search",
      recentAbort.signal.aborted && "recent messages",
    ].filter(Boolean).join(" and ");
    parts.push(`[System Warning] ${missing} timed out — you are responding without full context. Be helpful but note if unsure about recent context.`);
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

import { readFile, writeFile, readdir, mkdir, unlink, rename } from "fs/promises";
import { join } from "path";
import { MUAVIN_DIR, loadJson, timeAgo } from "./utils";
import type { Job } from "./jobs";

const AGENTS_DIR = join(MUAVIN_DIR, "agents");

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

export async function getAgentSummary(): Promise<string> {
  const running = await listAgents({ status: "running" });
  const completed = await listAgents({ status: "completed" });

  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  const recentCompleted = completed.filter((a) => {
    const completedAt = a.completedAt
      ? new Date(a.completedAt).getTime()
      : 0;
    return completedAt >= oneHourAgo;
  });

  if (running.length === 0 && recentCompleted.length === 0) {
    return "";
  }

  const lines: string[] = ["[Background Agents]"];

  for (const agent of running) {
    const startedAt = agent.startedAt
      ? new Date(agent.startedAt).getTime()
      : now;
    const elapsed = Math.floor((now - startedAt) / 1000 / 60);
    lines.push(`Running: "${agent.task}" (${elapsed}m elapsed)`);
  }

  for (const agent of recentCompleted) {
    const completedAt = agent.completedAt
      ? new Date(agent.completedAt).getTime()
      : now;
    const ago = Math.floor((now - completedAt) / 1000 / 60);
    lines.push(`Completed: "${agent.task}" (${ago}m ago)`);
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
      }, 15000)),
    ]).catch(() => []),

    (full && opts.chatId && opts.recentCount)
      ? Promise.race([
          getRecentMessages(String(opts.chatId), opts.recentCount, recentAbort.signal),
          new Promise<[]>(resolve => setTimeout(() => {
            console.error("buildContext: recent messages timed out (15s)");
            recentAbort.abort();
            resolve([]);
          }, 15000)),
        ]).catch(() => [])
      : Promise.resolve([]),
  ]);

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
    const agentSummary = await getAgentSummary();
    if (agentSummary) parts.push(agentSummary);
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

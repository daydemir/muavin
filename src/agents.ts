import { readFile, writeFile, readdir, mkdir, unlink, rename } from "fs/promises";
import { join } from "path";

const MUAVIN_DIR = join(process.env.HOME ?? "~", ".muavin");
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
}

export async function createAgent(opts: {
  task: string;
  prompt: string;
  chatId: number;
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
  };

  const filePath = join(AGENTS_DIR, `${id}.json`);
  await writeFile(filePath, JSON.stringify(agent, null, 2));

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
  updates: Partial<AgentFile>
): Promise<void> {
  const filePath = join(AGENTS_DIR, `${id}.json`);
  const current = await getAgent(id);
  if (!current) throw new Error(`Agent ${id} not found`);

  const updated = { ...current, ...updates };
  const tmpPath = `${filePath}.tmp`;

  await writeFile(tmpPath, JSON.stringify(updated, null, 2));
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
    const resultPreview = agent.result
      ? agent.result.slice(0, 100)
      : "no result";
    lines.push(`Completed: "${agent.task}" (${ago}m ago) — ${resultPreview}...`);
  }

  return lines.join("\n");
}

export async function getJobsSummary(): Promise<string> {
  const configPath = join(MUAVIN_DIR, "config.json");
  const jobsPath = join(MUAVIN_DIR, "jobs.json");
  const cronStatePath = join(MUAVIN_DIR, "cron-state.json");

  const lines: string[] = [];

  try {
    // Load system jobs
    const config = JSON.parse(await readFile(configPath, "utf-8"));
    const systemJobs: Array<{ id: string; schedule: string; action?: string; prompt?: string }> = config.cron ?? [];

    // Load user jobs
    let userJobs: Array<{ id: string; name: string; schedule: string; prompt: string; enabled?: boolean }> = [];
    try {
      userJobs = JSON.parse(await readFile(jobsPath, "utf-8"));
      userJobs = userJobs.filter(j => j.enabled !== false);
    } catch {}

    // Load cron state for last run times
    let cronState: Record<string, number> = {};
    try {
      cronState = JSON.parse(await readFile(cronStatePath, "utf-8"));
    } catch {}

    if (systemJobs.length === 0 && userJobs.length === 0) return "";

    lines.push("[Active Jobs]");
    for (const job of systemJobs) {
      const lastRun = cronState[job.id];
      const lastRunStr = lastRun ? `last: ${timeAgoShort(lastRun)}` : "never run";
      const label = job.action ?? "custom prompt";
      lines.push(`  ${job.id} (system, ${label}) — ${job.schedule} — ${lastRunStr}`);
    }
    for (const job of userJobs) {
      const lastRun = cronState[job.id];
      const lastRunStr = lastRun ? `last: ${timeAgoShort(lastRun)}` : "never run";
      lines.push(`  ${job.name || job.id} (user) — ${job.schedule} — ${lastRunStr}`);
    }
  } catch {
    return "";
  }

  return lines.join("\n");
}

function timeAgoShort(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function buildSessionContext(): Promise<string | undefined> {
  const parts: string[] = [];
  const agentSummary = await getAgentSummary();
  if (agentSummary) parts.push(agentSummary);
  const jobsSummary = await getJobsSummary();
  if (jobsSummary) parts.push(jobsSummary);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export async function cleanupAgents(maxAgeMs: number): Promise<number> {
  const agents = await listAgents();
  const now = Date.now();
  let deleted = 0;

  for (const agent of agents) {
    if (agent.status !== "completed" && agent.status !== "failed") {
      continue;
    }

    const timestamp = agent.completedAt ?? agent.createdAt;
    const age = now - new Date(timestamp).getTime();

    if (age > maxAgeMs) {
      try {
        await unlink(join(AGENTS_DIR, `${agent.id}.json`));
        deleted++;
      } catch {
        // Skip if file can't be deleted
        continue;
      }
    }
  }

  return deleted;
}

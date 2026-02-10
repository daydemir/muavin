import { readFile, writeFile, unlink, rename } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export const MUAVIN_DIR = join(homedir(), ".muavin");

export interface Config {
  owner: number;
  allowUsers: number[];
  allowGroups: number[];
  model?: string;
  claudeTimeoutMs?: number;
  agentMaxTurns?: number;
  agentTimeoutMs?: number;
  startOnLogin?: boolean;
  recentMessageCount?: number;
  repoPath?: string;
  [key: string]: unknown;
}

export async function acquireLock(name: string): Promise<boolean> {
  const lockFile = join(MUAVIN_DIR, `${name}.lock`);
  try {
    const existing = await readFile(lockFile, "utf-8").catch(() => null);
    if (existing) {
      const pid = parseInt(existing);
      try {
        process.kill(pid, 0);
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log(`Stale lock detected (PID: ${pid}), removing lock file`);
        await unlink(lockFile);
      }
    }
    await writeFile(lockFile, process.pid.toString(), { flag: "wx" });
    return true;
  } catch (err: any) {
    if (err?.code === "EEXIST") return false;
    return false;
  }
}

export async function releaseLock(name: string): Promise<void> {
  const lockFile = join(MUAVIN_DIR, `${name}.lock`);
  await unlink(lockFile).catch(() => {});
}

export async function loadJson<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function saveJson(path: string, data: unknown): Promise<void> {
  const tmpFile = `${path}.tmp`;
  await writeFile(tmpFile, JSON.stringify(data, null, 2));
  await rename(tmpFile, path);
}

export async function loadConfig(): Promise<Config> {
  const configPath = join(MUAVIN_DIR, "config.json");
  const config = await loadJson<Config>(configPath);
  if (!config) {
    throw new Error("config.json not found in ~/.muavin/. Run 'bun muavin setup'");
  }
  return config;
}

export function timestamp(prefix: string): string {
  return `[${prefix} ${new Date().toISOString()}]`;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

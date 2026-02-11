import { readFile, writeFile, unlink, rename, readdir, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export const MUAVIN_DIR = join(homedir(), ".muavin");

export interface Config {
  owner: number;
  allowUsers: number[];
  allowGroups: number[];
  model?: string;
  claudeTimeoutMs?: number;
  maxTurns?: number;
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

// ── Outbox ──────────────────────────────────────────────────

const OUTBOX_DIR = join(MUAVIN_DIR, "outbox");

export interface OutboxItem {
  source: "agent" | "job" | "heartbeat";
  sourceId?: string;
  task?: string;
  result: string;
  chatId: number;
  createdAt: string;
}

export async function writeOutbox(item: OutboxItem): Promise<void> {
  await mkdir(OUTBOX_DIR, { recursive: true });
  const filename = `${Date.now()}_${item.source}${item.sourceId ? `_${item.sourceId}` : ""}.json`;
  const filePath = join(OUTBOX_DIR, filename);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(item, null, 2));
  await rename(tmpPath, filePath);
}

export async function readOutbox(): Promise<Array<OutboxItem & { _filename: string }>> {
  await mkdir(OUTBOX_DIR, { recursive: true });
  const files = await readdir(OUTBOX_DIR);
  const items: Array<OutboxItem & { _filename: string }> = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = await readFile(join(OUTBOX_DIR, file), "utf-8");
      const item: OutboxItem = JSON.parse(content);
      items.push({ ...item, _filename: file });
    } catch {
      // Skip and delete corrupted files
      await unlink(join(OUTBOX_DIR, file)).catch(() => {});
    }
  }

  return items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export async function clearOutboxItems(filenames: string[]): Promise<void> {
  for (const filename of filenames) {
    await unlink(join(OUTBOX_DIR, filename)).catch(() => {});
  }
}

// ── Launchd helpers ─────────────────────────────────────────

export async function waitForUnload(label: string, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = Bun.spawn(["launchctl", "list", label], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    if (p.exitCode !== 0) return true;
    await Bun.sleep(100);
  }
  return false;
}

export async function reloadService(uid: string, label: string, plistPath: string): Promise<{ ok: boolean; exitCode: number }> {
  const bout = Bun.spawn(["launchctl", "bootout", `gui/${uid}/${label}`], { stdout: "pipe", stderr: "pipe" });
  await bout.exited;

  if (bout.exitCode === 0) {
    await waitForUnload(label);
  }

  const bs = Bun.spawn(["launchctl", "bootstrap", `gui/${uid}`, plistPath], { stdout: "pipe", stderr: "pipe" });
  await bs.exited;

  return { ok: bs.exitCode === 0, exitCode: bs.exitCode ?? -1 };
}

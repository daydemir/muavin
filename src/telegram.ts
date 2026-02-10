import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const MUAVIN_DIR = join(process.env.HOME ?? "~", ".muavin");
const PENDING_ALERTS_PATH = join(MUAVIN_DIR, "pending-alerts.json");

interface PendingAlert {
  chatId: number;
  text: string;
  opts?: { parseMode?: string };
  failedAt: number;
}

export async function sendTelegram(
  chatId: number,
  text: string,
  opts?: { parseMode?: string }
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  const body: { chat_id: number; text: string; parse_mode?: string } = {
    chat_id: chatId,
    text,
  };

  if (opts?.parseMode) {
    body.parse_mode = opts.parseMode;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    console.error(`sendTelegram failed: ${res.status} ${responseBody}`);

    // Append to pending alerts
    try {
      await mkdir(MUAVIN_DIR, { recursive: true });
      let pending: PendingAlert[] = [];
      try {
        const content = await readFile(PENDING_ALERTS_PATH, "utf-8");
        pending = JSON.parse(content);
      } catch {
        // File doesn't exist or is invalid, start fresh
      }

      pending.push({
        chatId,
        text,
        opts,
        failedAt: Date.now(),
      });

      await writeFile(PENDING_ALERTS_PATH, JSON.stringify(pending, null, 2));
    } catch (e) {
      console.error("Failed to save pending alert:", e);
    }

    return false;
  }

  return true;
}

export async function checkPendingAlerts(): Promise<void> {
  try {
    const content = await readFile(PENDING_ALERTS_PATH, "utf-8");
    const pending: PendingAlert[] = JSON.parse(content);

    if (pending.length === 0) return;

    const stillPending: PendingAlert[] = [];

    for (const alert of pending) {
      const success = await sendTelegram(alert.chatId, alert.text, alert.opts);
      if (!success) {
        stillPending.push(alert);
      } else {
        console.log(`Retry succeeded for alert from ${new Date(alert.failedAt).toISOString()}`);
      }
    }

    // Write back only the alerts that still failed
    await writeFile(PENDING_ALERTS_PATH, JSON.stringify(stillPending, null, 2));
  } catch (e) {
    // If file doesn't exist or is invalid, that's fine
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("checkPendingAlerts error:", e);
    }
  }
}

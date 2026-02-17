export function toTelegramMarkdown(text: string): string {
  // Phase 1: Extract existing code blocks into placeholders
  const blocks: string[] = [];
  let result = text.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `\0CB${blocks.length - 1}\0`;
  });

  // Phase 2: Convert markdown tables to code blocks, then format
  result = result
    .replace(/((?:^|\n)\|[^\n]+\|[ \t]*(?:\n\|[^\n]+\|[ \t]*)*)/g, (match) => {
      const prefix = match.startsWith("\n") ? "\n" : "";
      return `${prefix}\`\`\`\n${match.trim()}\n\`\`\``;
    })
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    .replace(/__(.*?)__/g, "_$1_")
    .replace(/~~(.*?)~~/g, "$1");

  // Phase 3: Restore code blocks
  return result.replace(/\0CB(\d+)\0/g, (_, i) => blocks[Number(i)]);
}

export async function sendTelegram(
  chatId: number,
  text: string,
  opts?: { parseMode?: string }
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let parseMode = opts?.parseMode;

  for (let attempt = 0; attempt < 3; attempt++) {
    const body: { chat_id: number; text: string; parse_mode?: string } = {
      chat_id: chatId,
      text: parseMode ? toTelegramMarkdown(text) : text,
    };
    if (parseMode) body.parse_mode = parseMode;

    try {
      const res = await fetch(url, {
        method: "POST",
        keepalive: false,
        headers: { "Content-Type": "application/json", "Connection": "close" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      } as RequestInit);

      if (res.ok) return true;

      const responseBody = await res.text().catch(() => "");
      console.error(`sendTelegram failed (attempt ${attempt + 1}): ${res.status} ${responseBody}`);

      // 400 with parseMode → retry without markdown
      if (res.status === 400 && parseMode) {
        parseMode = undefined;
        continue;
      }

      // 5xx → retry with backoff
      if (res.status >= 500) {
        await Bun.sleep((attempt + 1) * 1000);
        continue;
      }

      // Other 4xx → fail immediately
      return false;
    } catch (e) {
      console.error(`sendTelegram error (attempt ${attempt + 1}):`, e);
      if (attempt < 2) {
        await Bun.sleep((attempt + 1) * 1000);
        continue;
      }
      return false;
    }
  }

  return false;
}

export async function sendAndLog(
  chatId: number,
  text: string,
  opts?: { parseMode?: string },
): Promise<boolean> {
  const { logMessage } = await import("./memory");
  const success = await sendTelegram(chatId, text, opts);
  if (success) {
    logMessage("assistant", text, String(chatId)).catch(e =>
      console.error("sendAndLog logMessage failed:", e)
    );
  }
  return success;
}

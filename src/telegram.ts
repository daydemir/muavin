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

  const body: { chat_id: number; text: string; parse_mode?: string } = {
    chat_id: chatId,
    text: opts?.parseMode ? toTelegramMarkdown(text) : text,
  };

  if (opts?.parseMode) {
    body.parse_mode = opts.parseMode;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    keepalive: false,
    headers: { "Content-Type": "application/json", "Connection": "close" },
    body: JSON.stringify(body),
  } as RequestInit);

  if (!res.ok) {
    const responseBody = await res.text().catch(() => "");
    console.error(`sendTelegram failed: ${res.status} ${responseBody}`);

    // Retry without parse_mode on 400 error if parse_mode was set
    if (res.status === 400 && opts?.parseMode) {
      console.log("Retrying without parse_mode due to 400 error");
      const plainBody = {
        chat_id: chatId,
        text,
      };

      const retryRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        keepalive: false,
        headers: { "Content-Type": "application/json", "Connection": "close" },
        body: JSON.stringify(plainBody),
      } as RequestInit);

      if (!retryRes.ok) {
        const retryResponseBody = await retryRes.text().catch(() => "");
        console.error(`sendTelegram retry failed: ${retryRes.status} ${retryResponseBody}`);
        return false;
      }

      return true;
    }

    return false;
  }

  return true;
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

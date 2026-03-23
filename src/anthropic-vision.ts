import { readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

function requiredAnthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (key) return key;

  try {
    const envPath = join(homedir(), ".muavin", ".env");
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const match = line.match(/^ANTHROPIC_API_KEY=(.*)$/);
      if (!match) continue;
      const fallback = match[1].trim();
      if (fallback) return fallback;
    }
  } catch {}

  throw new Error("ANTHROPIC_API_KEY not set");
}

function anthropicModelForAlias(alias: string | undefined): string {
  switch (alias) {
    case "opus":
      return "claude-opus-4-1";
    case "haiku":
      return "claude-3-5-haiku-latest";
    case "sonnet":
    default:
      return "claude-sonnet-4-0";
  }
}

export async function analyzeImageWithAnthropic(input: {
  imagePath: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  prompt: string;
  systemPrompt?: string;
  modelAlias?: string;
  maxTokens?: number;
}): Promise<string> {
  const bytes = await Bun.file(input.imagePath).bytes();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": requiredAnthropicKey(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: anthropicModelForAlias(input.modelAlias),
      max_tokens: input.maxTokens ?? 220,
      temperature: 0.5,
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: input.mediaType,
                data: Buffer.from(bytes).toString("base64"),
              },
            },
            {
              type: "text",
              text: input.prompt,
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`anthropic vision failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string };
  };

  const text = (payload.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(`anthropic vision returned empty text for ${basename(input.imagePath)}`);
  }

  return text;
}

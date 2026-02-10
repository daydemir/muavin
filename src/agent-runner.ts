import { validateEnv } from "./env";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { readFileSync } from "fs";
import { join } from "path";
import { callClaude } from "./claude";
import { sendTelegram } from "./telegram";
import { logMessage, searchContext } from "./memory";
import {
  getAgent,
  updateAgent,
  listAgents,
  buildContext,
  type AgentFile,
} from "./agents";

validateEnv();

const MUAVIN_DIR = join(process.env.HOME ?? "~", ".muavin");
const LOCK_FILE = join(MUAVIN_DIR, "agent-runner.lock");

await mkdir(MUAVIN_DIR, { recursive: true });

const timestamp = () => `[agent-runner ${new Date().toISOString()}]`;

// ── Parse args ──────────────────────────────────────────────────

const loopMode = process.argv.includes("--loop") || Bun.argv.includes("--loop");

// ── Lock file ───────────────────────────────────────────────────

async function acquireLock(): Promise<boolean> {
  try {
    const existing = await readFile(LOCK_FILE, "utf-8").catch(() => null);
    if (existing) {
      const pid = parseInt(existing);
      try {
        process.kill(pid, 0);
        console.log(`${timestamp()} Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log(
          `${timestamp()} Stale lock detected (PID: ${pid}), removing lock file`,
        );
        await unlink(LOCK_FILE);
      }
    }
    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

if (!(await acquireLock())) {
  console.error(
    `${timestamp()} Could not acquire lock. Another instance may be running.`,
  );
  process.exit(1);
}

// ── Config ──────────────────────────────────────────────────────

const configPath = join(process.env.HOME ?? "~", ".muavin", "config.json");
try {
  await readFile(configPath);
} catch {
  console.error(
    `${timestamp()} config.json not found in ~/.muavin/. Run 'bun muavin setup'`,
  );
  await releaseLock();
  process.exit(1);
}

const config = JSON.parse(await readFile(configPath, "utf-8"));
const agentMaxTurns = config.maxTurns ?? 100;
const agentTimeoutMs = config.agentTimeoutMs ?? 600000;

// ── Core logic ──────────────────────────────────────────────────

async function processAgents(): Promise<boolean> {
  // Check for status updates on running agents
  const runningAgents = await listAgents({ status: "running" });

  for (const agent of runningAgents) {
    const startedAt = agent.startedAt
      ? new Date(agent.startedAt).getTime()
      : null;
    const lastStatusAt = agent.lastStatusAt
      ? new Date(agent.lastStatusAt).getTime()
      : null;
    const now = Date.now();

    const elapsed = startedAt ? now - startedAt : 0;
    const lastStatus = lastStatusAt ?? startedAt ?? now;
    const minutesSinceStatus = (now - lastStatus) / 1000 / 60;

    // Send status update if >5 minutes since start or last status
    if (minutesSinceStatus >= 5) {
      const elapsedMin = Math.floor(elapsed / 1000 / 60);
      const statusMsg = `Your background task '${agent.task}' is still running (${elapsedMin} minutes elapsed)...`;

      await sendTelegram(agent.chatId, statusMsg);
      await updateAgent(agent.id, { lastStatusAt: new Date().toISOString() });
    }

    // Check for stuck agents (>2h and PID is dead)
    if (elapsed > 2 * 60 * 60 * 1000 && agent.pid) {
      try {
        process.kill(agent.pid, 0);
      } catch {
        console.log(
          `${timestamp()} Agent ${agent.id} stuck (PID ${agent.pid} is dead)`,
        );
        await updateAgent(agent.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: "Agent process died",
        });
        await sendTelegram(
          agent.chatId,
          `Background task failed: ${agent.task}\nAgent process died`,
        );
      }
    }
  }

  // Process pending agents
  const pendingAgents = await listAgents({ status: "pending" });

  for (const agent of pendingAgents) {
    try {
      // Mark as running
      await updateAgent(agent.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        pid: process.pid,
      });

      // Execute the agent prompt
      const appendSystemPrompt = await buildContext({ query: agent.task });
      const result = await callClaude(agent.prompt, {
        noSessionPersistence: true,
        timeoutMs: agentTimeoutMs,
        maxTurns: agentMaxTurns,
        appendSystemPrompt,
      });

      console.log(
        `${timestamp()} Agent ${agent.id} completed`,
      );

      // Mark as completed
      await updateAgent(agent.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        result: result.text,
      });

      // Deliver via stateless Claude
      const recentMessages = await searchContext(agent.task, 5).catch(() => []);

      const contextStr =
        recentMessages.length > 0
          ? recentMessages.map((r) => `[${r.source}] ${r.content}`).join("\n")
          : "No recent context found.";

      const promptsDir = join(process.env.HOME ?? "~", ".muavin", "prompts");
      const deliveryTemplate = readFileSync(join(promptsDir, "agent-delivery.md"), "utf-8");
      const deliveryPrompt = deliveryTemplate
        .replace("{{TASK}}", agent.task)
        .replace("{{CONTEXT}}", contextStr)
        .replace("{{RESULTS}}", result.text);

      const deliveryContext = await buildContext({ query: agent.task });
      const deliveryResult = await callClaude(deliveryPrompt, {
        noSessionPersistence: true,
        appendSystemPrompt: deliveryContext,
      });

      const deliveryText = deliveryResult.text.trim();

      if (deliveryText === "SKIP") {
        await updateAgent(agent.id, { deliveredResult: "SKIP" });
      } else {
        await updateAgent(agent.id, { deliveredResult: deliveryText });
        await sendTelegram(agent.chatId, deliveryText, {
          parseMode: "Markdown",
        });
        logMessage("assistant", deliveryText, String(agent.chatId)).catch(
          (e) => console.error(`${timestamp()} logMessage failed:`, e),
        );
      }
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "Unknown error";
      console.error(`${timestamp()} Agent ${agent.id} failed:`, error);

      await updateAgent(agent.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: errorMsg,
      });

      await sendTelegram(
        agent.chatId,
        `Background task failed: ${agent.task}\n${errorMsg}`,
      );
    }
  }

  // Return true if there was any activity
  const hadActivity = pendingAgents.length > 0 || runningAgents.length > 0;
  return hadActivity;
}

// ── Main execution ──────────────────────────────────────────────

async function main() {
  try {
    if (loopMode) {
      console.log(`${timestamp()} Starting in loop mode`);
      let idleChecks = 0;

      while (true) {
        const hadActivity = await processAgents();

        if (!hadActivity) {
          idleChecks++;

          if (idleChecks >= 3) {
            console.log(`${timestamp()} No activity for 3 checks, exiting`);
            break;
          }
        } else {
          idleChecks = 0;
        }

        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    } else {
      await processAgents();
    }
  } finally {
    await releaseLock();
  }
}

// ── Graceful shutdown ───────────────────────────────────────────

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`${timestamp()} Received ${sig}, shutting down...`);
    await releaseLock();
    process.exit(0);
  });
}

// ── Start ───────────────────────────────────────────────────────

console.log(`${timestamp()} Starting agent runner (loop: ${loopMode})`);

main().catch((error) => {
  console.error(`${timestamp()} Fatal error:`, error);
  releaseLock().finally(() => process.exit(1));
});

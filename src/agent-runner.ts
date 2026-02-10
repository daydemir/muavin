import { validateEnv } from "./env";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { callClaude } from "./claude";
import { sendTelegram } from "./telegram";
import { logMessage, searchContext } from "./memory";
import {
  getAgent,
  updateAgent,
  listAgents,
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
const agentMaxTurns = config.agentMaxTurns ?? 25;
const agentTimeoutMs = config.agentTimeoutMs ?? 600000;

// ── Core logic ──────────────────────────────────────────────────

async function processAgents(): Promise<boolean> {
  console.log(`${timestamp()} processAgents: starting`);

  // Check for status updates on running agents
  const runningAgents = await listAgents({ status: "running" });
  console.log(`${timestamp()} Found ${runningAgents.length} running agents`);

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

      console.log(`${timestamp()} Sending status update for agent ${agent.id}`);
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
  console.log(`${timestamp()} Found ${pendingAgents.length} pending agents`);

  for (const agent of pendingAgents) {
    console.log(`${timestamp()} Processing agent ${agent.id}: ${agent.task}`);

    try {
      // Mark as running
      await updateAgent(agent.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        pid: process.pid,
      });

      // Execute the agent prompt
      console.log(
        `${timestamp()} Calling Claude for agent ${agent.id} (maxTurns: ${agentMaxTurns}, timeout: ${agentTimeoutMs}ms)`,
      );
      const result = await callClaude(agent.prompt, {
        noSessionPersistence: true,
        timeoutMs: agentTimeoutMs,
        maxTurns: agentMaxTurns,
      });

      console.log(
        `${timestamp()} Agent ${agent.id} completed: ${result.text.length} chars, cost: $${result.costUsd.toFixed(4)}`,
      );

      // Mark as completed
      await updateAgent(agent.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        result: result.text,
      });

      // Deliver via stateless Claude
      console.log(`${timestamp()} Fetching context for delivery`);
      const recentMessages = await searchContext(agent.task, 5).catch(() => []);

      const contextStr =
        recentMessages.length > 0
          ? recentMessages.map((r) => `[${r.source}] ${r.content}`).join("\n")
          : "No recent context found.";

      const deliveryPrompt = `[Background Task Complete] Your background task "${agent.task}" has finished.

Here is recent conversation context:
${contextStr}

Here are the raw results:
${result.text}

Synthesize these results and present them to the user naturally, as part of the ongoing conversation.`;

      console.log(`${timestamp()} Calling Claude for delivery`);
      const deliveryResult = await callClaude(deliveryPrompt, {
        noSessionPersistence: true,
      });

      // Save delivered result
      await updateAgent(agent.id, { deliveredResult: deliveryResult.text });

      // Send to Telegram
      console.log(
        `${timestamp()} Sending delivery to Telegram (chatId: ${agent.chatId})`,
      );
      await sendTelegram(agent.chatId, deliveryResult.text, {
        parseMode: "Markdown",
      });

      // Log to memory
      logMessage("assistant", deliveryResult.text, String(agent.chatId)).catch(
        (e) => console.error(`${timestamp()} logMessage failed:`, e),
      );

      console.log(`${timestamp()} Agent ${agent.id} fully delivered`);
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
  console.log(
    `${timestamp()} processAgents: completed (hadActivity: ${hadActivity})`,
  );
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
          console.log(
            `${timestamp()} Idle check ${idleChecks}/3, sleeping 30s`,
          );

          if (idleChecks >= 3) {
            console.log(`${timestamp()} No activity for 3 checks, exiting`);
            break;
          }
        } else {
          idleChecks = 0;
          console.log(`${timestamp()} Activity detected, resetting idle checks`);
        }

        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    } else {
      console.log(`${timestamp()} Single run mode`);
      await processAgents();
    }
  } finally {
    await releaseLock();
    console.log(`${timestamp()} Shutdown complete`);
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
console.log(
  `${timestamp()} Config: maxTurns=${agentMaxTurns}, timeout=${agentTimeoutMs}ms`,
);

main().catch((error) => {
  console.error(`${timestamp()} Fatal error:`, error);
  releaseLock().finally(() => process.exit(1));
});

import { spawn } from "bun";
import { callClaude } from "./claude";
import {
  writeOutbox,
  loadJson,
  saveJson,
  MUAVIN_DIR,
  acquireLock,
  releaseLock,
} from "./utils";
import type { Job } from "./jobs";
import type { Config } from "./utils";

const REPO = "daydemir/muavin";
const BRANCH = "auto-safe";
const MAX_DIFF_LINES = 100;
const MAX_COMMITS_AHEAD = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const DAILY_COST_CAP_USD = 5;

interface Issue {
  number: number;
  title: string;
  body: string;
}

interface AutoSafeState {
  consecutiveFailures: number;
  dailyCosts: Record<string, number>; // "YYYY-MM-DD" -> cost in USD
  skippedIssues: Record<number, number>; // issue number -> skip count
  fixedIssues: number[]; // issue numbers already fixed
}

async function exec(cmd: string[], cwd: string): Promise<void> {
  const proc = spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`${cmd.join(" ")} failed (${exitCode}): ${stderr}`);
  }
}

async function execCapture(
  cmd: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

export async function runAutoSafe(job: Job, config: Config): Promise<void> {
  const lockAcquired = await acquireLock("auto-safe");
  if (!lockAcquired) {
    console.log("auto-safe: lock already held, skipping");
    return;
  }

  try {
    const stateFile = `${MUAVIN_DIR}/auto-safe-state.json`;
    let state: AutoSafeState = (await loadJson<AutoSafeState>(stateFile)) ?? {
      consecutiveFailures: 0,
      dailyCosts: {},
      skippedIssues: {},
      fixedIssues: [],
    };

    // Check auto-disable
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(
        `auto-safe: disabled after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`
      );
      await writeOutbox({
        source: "job",
        sourceId: "auto-safe",
        task: "Auto-safe issue fixer",
        result: `auto-safe: auto-disabled after ${MAX_CONSECUTIVE_FAILURES} failures — needs manual intervention`,
        chatId: config.owner,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    // Check daily cost cap
    const today = new Date().toISOString().split("T")[0];
    const todayCost = state.dailyCosts[today] || 0;
    if (todayCost >= DAILY_COST_CAP_USD) {
      console.log(
        `auto-safe: daily cost cap reached ($${todayCost.toFixed(2)} / $${DAILY_COST_CAP_USD})`
      );
      return;
    }

    // Check gh auth
    const ghAuthResult = await execCapture(["gh", "auth", "status"], process.cwd());
    if (ghAuthResult.exitCode !== 0) {
      console.error("auto-safe: gh auth not configured");
      return;
    }

    // Fetch open auto-safe issues
    const issuesResult = await execCapture(
      [
        "gh",
        "issue",
        "list",
        "--repo",
        REPO,
        "--label",
        "auto-safe",
        "--state",
        "open",
        "--json",
        "number,title,body",
        "--limit",
        "20",
      ],
      process.cwd()
    );

    if (issuesResult.exitCode !== 0) {
      console.error("auto-safe: failed to fetch issues");
      return;
    }

    const allIssues: Issue[] = JSON.parse(issuesResult.stdout);

    // Filter issues
    const issues = allIssues.filter((issue) => {
      // Skip if already fixed
      if (state.fixedIssues.includes(issue.number)) {
        return false;
      }

      // Skip if skipped 3+ times
      const skipCount = state.skippedIssues[issue.number] || 0;
      if (skipCount >= 3) {
        // Remove auto-safe label and comment
        execCapture(
          [
            "gh",
            "issue",
            "edit",
            issue.number.toString(),
            "--repo",
            REPO,
            "--remove-label",
            "auto-safe",
          ],
          process.cwd()
        ).catch(console.error);
        execCapture(
          [
            "gh",
            "issue",
            "comment",
            issue.number.toString(),
            "--repo",
            REPO,
            "--body",
            "auto-safe: skipped 3 times, removing label for manual attention",
          ],
          process.cwd()
        ).catch(console.error);
        return false;
      }

      return true;
    });

    if (issues.length === 0) {
      console.log("auto-safe: no issues to process");
      return;
    }

    // Pick oldest (FIFO)
    const issue = issues[0];

    // Get repo dir
    const repoDir = config.repoPath || "/Users/deniz/Build/deniz/claw";

    // Ensure branch
    await exec(["git", "fetch", "origin"], repoDir);

    const branchCheckResult = await execCapture(
      ["git", "rev-parse", "--verify", `origin/${BRANCH}`],
      repoDir
    );

    if (branchCheckResult.exitCode === 0) {
      // Branch exists remotely
      await exec(["git", "checkout", BRANCH], repoDir);
      await exec(["git", "rebase", "origin/main"], repoDir);
    } else {
      // Create from main
      await exec(["git", "checkout", "main"], repoDir);
      await exec(["git", "pull", "origin", "main"], repoDir);
      await exec(["git", "checkout", "-b", BRANCH], repoDir);
    }

    // Check commits ahead
    const commitsAheadResult = await execCapture(
      ["git", "rev-list", "--count", `origin/main..${BRANCH}`],
      repoDir
    );
    const commitsAhead = parseInt(commitsAheadResult.stdout.trim(), 10);
    if (commitsAhead >= MAX_COMMITS_AHEAD) {
      console.log(
        "auto-safe: too many uncommitted fixes, waiting for merge"
      );
      return;
    }

    // Save pre-fix sha
    const preShaResult = await execCapture(
      ["git", "rev-parse", "HEAD"],
      repoDir
    );
    const preSha = preShaResult.stdout.trim();

    // Triage
    const triagePrompt = `You are a triage agent for the muavin project. Your job is to decide whether a GitHub issue is safe to fix autonomously.

## Issue #${issue.number}: ${issue.title}

${issue.body || "(no description)"}

## Your task

1. Read the relevant source files mentioned in or implied by the issue
2. Assess:
   - Is the issue well-defined with a clear fix?
   - Is the fix localized (touches ≤3 files)?
   - Could the fix break existing functionality?
   - Does it require architectural decisions?
   - Does it require new dependencies?

3. Respond with EXACTLY this JSON format:
{
  "decision": "GO" or "SKIP",
  "reasoning": "one sentence explaining why",
  "files": ["list", "of", "files", "to", "modify"],
  "approach": "brief description of the fix approach"
}

Rules:
- SKIP if the issue is vague, requires architectural decisions, or could break things
- SKIP if it requires new npm packages or external service changes
- SKIP if it touches more than 3 files
- GO only if the fix is obvious, localized, and low-risk
- When in doubt, SKIP`;

    const triageResult = await callClaude(triagePrompt, {
      noSessionPersistence: true,
      maxTurns: 20,
      timeoutMs: 120_000,
      cwd: repoDir,
      model: job.model ?? "sonnet",
    });

    // Track triage cost
    state.dailyCosts[today] = (state.dailyCosts[today] || 0) + triageResult.costUsd;
    await saveJson(stateFile, state);

    // Parse triage decision
    let triageDecision: {
      decision: string;
      reasoning: string;
      files: string[];
      approach: string;
    };

    try {
      // Extract JSON from response
      const jsonMatch = triageResult.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      triageDecision = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error("auto-safe: failed to parse triage response", e);
      state.skippedIssues[issue.number] =
        (state.skippedIssues[issue.number] || 0) + 1;
      await saveJson(stateFile, state);
      return;
    }

    if (triageDecision.decision !== "GO") {
      console.log(
        `auto-safe: skipping issue #${issue.number} — ${triageDecision.reasoning}`
      );
      state.skippedIssues[issue.number] =
        (state.skippedIssues[issue.number] || 0) + 1;
      await saveJson(stateFile, state);
      return;
    }

    // Implement
    const implementPrompt = `You are an implementation agent for the muavin project. Fix the following GitHub issue.

## Issue #${issue.number}: ${issue.title}

${issue.body || "(no description)"}

## Triage assessment
Files to modify: ${triageDecision.files.join(", ")}
Approach: ${triageDecision.approach}

## Instructions

1. You are on the \`auto-safe\` branch in the muavin repo
2. Read and understand the relevant files
3. Make the minimal fix — no refactoring, no extras
4. Stage your changes: git add <specific files>
5. Commit with message:
   fix: ${issue.title}

   fixes #${issue.number}
6. Do NOT push — the orchestrator handles that
7. Do NOT modify any files outside the identified scope
8. Do NOT add new dependencies

If you cannot complete the fix, respond with "FAILED: <reason>" and do not commit anything.`;

    const implementResult = await callClaude(implementPrompt, {
      noSessionPersistence: true,
      maxTurns: 30,
      timeoutMs: 300_000,
      cwd: repoDir,
      model: job.model ?? "sonnet",
    });

    // Track implementation cost
    state.dailyCosts[today] = (state.dailyCosts[today] || 0) + implementResult.costUsd;
    await saveJson(stateFile, state);

    // Check if FAILED
    if (implementResult.text.startsWith("FAILED:")) {
      console.log(
        `auto-safe: implementation failed for #${issue.number} — ${implementResult.text}`
      );
      state.skippedIssues[issue.number] =
        (state.skippedIssues[issue.number] || 0) + 1;
      await saveJson(stateFile, state);
      return;
    }

    // Validate diff scope
    const diffResult = await execCapture(
      ["git", "diff", "--stat", "HEAD~1"],
      repoDir
    );
    const diffLines = diffResult.stdout.split("\n");
    const totalChanges = diffLines
      .filter((line) => line.includes("|"))
      .reduce((sum, line) => {
        const match = line.match(/\d+\s+[+\-]+/);
        if (!match) return sum;
        const nums = match[0].match(/\d+/);
        return sum + (nums ? parseInt(nums[0], 10) : 0);
      }, 0);

    if (totalChanges > MAX_DIFF_LINES) {
      console.log(
        `auto-safe: diff too large (${totalChanges} lines) for #${issue.number}, rolling back`
      );
      await exec(["git", "reset", "--hard", preSha], repoDir);
      state.skippedIssues[issue.number] =
        (state.skippedIssues[issue.number] || 0) + 1;
      await saveJson(stateFile, state);
      return;
    }

    // Compile check
    const compileResult = await execCapture(
      [
        "bun",
        "build",
        "--compile",
        "src/relay.ts",
        "--outfile",
        "/tmp/muavin-check",
      ],
      repoDir
    );

    if (compileResult.exitCode !== 0) {
      console.error(
        `auto-safe: compile failed for #${issue.number}, rolling back`
      );
      await exec(["git", "reset", "--hard", preSha], repoDir);
      await execCapture(
        [
          "gh",
          "issue",
          "comment",
          issue.number.toString(),
          "--repo",
          REPO,
          "--body",
          "auto-safe attempted this but compile failed. reverting.",
        ],
        process.cwd()
      ).catch(console.error);
      state.consecutiveFailures++;
      await writeOutbox({
        source: "job",
        sourceId: "auto-safe",
        task: "Auto-safe issue fixer",
        result: `auto-safe: compile failed for #${issue.number} — rolled back, consecutive failures: ${state.consecutiveFailures}`,
        chatId: config.owner,
        createdAt: new Date().toISOString(),
      });
      await saveJson(stateFile, state);
      return;
    }

    // Clean up compile artifact
    await execCapture(["rm", "-f", "/tmp/muavin-check"], process.cwd());

    // Push
    const pushResult = await execCapture(
      ["git", "push", "origin", BRANCH],
      repoDir
    );

    if (pushResult.exitCode !== 0) {
      console.error(
        `auto-safe: push failed for #${issue.number} — ${pushResult.stderr}`
      );
      return;
    }

    // Manage PR
    const prListResult = await execCapture(
      [
        "gh",
        "pr",
        "list",
        "--repo",
        REPO,
        "--head",
        BRANCH,
        "--state",
        "open",
        "--json",
        "number,body",
      ],
      process.cwd()
    );

    const existingPrs: Array<{ number: number; body: string }> = JSON.parse(
      prListResult.stdout
    );

    const fixLine = `- fixes #${issue.number}: ${issue.title}`;

    if (existingPrs.length > 0) {
      const pr = existingPrs[0];
      if (!pr.body.includes(fixLine)) {
        const newBody = pr.body + "\n" + fixLine;
        await execCapture(
          [
            "gh",
            "pr",
            "edit",
            pr.number.toString(),
            "--repo",
            REPO,
            "--body",
            newBody,
          ],
          process.cwd()
        ).catch(console.error);
      }
    } else {
      // Create new PR
      await execCapture(
        [
          "gh",
          "pr",
          "create",
          "--repo",
          REPO,
          "--head",
          BRANCH,
          "--base",
          "main",
          "--title",
          "auto-safe: automated fixes",
          "--body",
          fixLine,
        ],
        process.cwd()
      ).catch(console.error);
    }

    // Comment on issue
    await execCapture(
      [
        "gh",
        "issue",
        "comment",
        issue.number.toString(),
        "--repo",
        REPO,
        "--body",
        "auto-safe: fix committed to `auto-safe` branch. PR will auto-close this when merged.",
      ],
      process.cwd()
    ).catch(console.error);

    // Update state
    state.fixedIssues.push(issue.number);
    state.consecutiveFailures = 0;
    await saveJson(stateFile, state);

    // Notify owner
    await writeOutbox({
      source: "job",
      sourceId: "auto-safe",
      task: "Auto-safe issue fixer",
      result: `auto-safe: fixed #${issue.number} (${issue.title}) — pushed to auto-safe branch, PR updated`,
      chatId: config.owner,
      createdAt: new Date().toISOString(),
    });

    console.log(`auto-safe: successfully fixed #${issue.number}`);
  } finally {
    await releaseLock("auto-safe");
  }
}

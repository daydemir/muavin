import { createClient } from "@supabase/supabase-js";

import { Bot } from "grammy";
import { Cron } from "croner";
import { resolve } from "path";
import { readFile, mkdir } from "fs/promises";
import pc from "picocolors";
import { listAgents } from "./agents";
import { seedDefaultJobs, type Job } from "./jobs";
import { EMBEDDING_DIMS, EMBEDDING_MODEL } from "./constants";

const ok = (msg: string) => console.log(pc.green(`✓ ${msg}`));
const fail = (msg: string) => console.error(pc.red(`✗ ${msg}`));
const warn = (msg: string) => console.log(pc.yellow(`⚠ ${msg}`));
const heading = (msg: string) => console.log(pc.bold(msg));
const dim = (msg: string) => console.log(pc.dim(msg));

async function testEmbedding(apiKey: string): Promise<void> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: "test", dimensions: EMBEDDING_DIMS }),
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
}

async function main() {
  const command = Bun.argv[2];

  switch (command) {
    case "setup":
      await setupCommand();
      break;
    case "start":
      await deployCommand();
      break;
    case "status":
      await statusCommand();
      break;
    case "test":
      await testCommand();
      break;
    case "config":
      await configCommand();
      break;
    case "stop":
      await stopCommand();
      break;
    case "agent":
      await agentCommand();
      break;
    case "write":
      await (await import("./blocks-cli")).writeCommand();
      break;
    case "crm":
      await (await import("./blocks-cli")).crmCommand(Bun.argv.slice(3));
      break;
    case "inbox":
      await (await import("./blocks-cli")).inboxCommand(Bun.argv.slice(3));
      break;
    case "ingest":
      await (await import("./blocks-cli")).ingestCommand(Bun.argv.slice(3));
      break;
    case "clarify":
      await (await import("./blocks-cli")).clarifyCommand(Bun.argv.slice(3));
      break;
    case "process":
      await (await import("./blocks-cli")).processCommand(Bun.argv.slice(3));
      break;
    case "live":
      await liveConversationCommand();
      break;
    default:
      heading("Muavin CLI\n");
      console.log("Usage: bun muavin <command>\n");
      console.log("Commands:");
      console.log("  setup   - Interactive setup wizard");
      console.log("  config  - Edit configuration (use --reset to restore defaults)");
      console.log("  start   - Deploy launch daemons");
      console.log("  stop    - Stop all daemons");
      console.log("  status  - Check daemon and session status");
      console.log("  test    - Run smoke tests");
      console.log("  agent   - Manage background agents");
      console.log("  write   - Block writing UI (CLI)");
      console.log("  crm     - CRM timeline and ROI view");
      console.log("  inbox   - Inspect ingested artifacts");
      console.log("  ingest  - Run inbox ingestion");
      console.log("  clarify - Run/answer clarification queue");
      console.log("  process - Run state processor manually");
      console.log("  live    - Open a live Claude conversation with Muavin prompt");
      process.exit(0);
  }
}

async function liveConversationCommand() {
  heading("Starting live Muavin conversation...\n");
  const muavinDir = `${process.env.HOME}/.muavin`;
  const muavinPromptPath = `${muavinDir}/muavin.md`;
  const args = ["claude"];

  const promptFile = Bun.file(muavinPromptPath);
  if (await promptFile.exists()) {
    const promptContent = (await promptFile.text()).trim();
    if (promptContent) {
      args.push("--append-system-prompt", promptContent);
    }
  } else {
    warn(`muavin prompt not found at ${muavinPromptPath}; starting plain claude session`);
  }

  const proc = Bun.spawn(args, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: muavinDir,
  });
  await proc.exited;

  if (proc.exitCode !== 0) {
    fail(`claude exited with code ${proc.exitCode}`);
  }
}

async function setupCommand() {
  heading("🚀 Muavin Setup Wizard\n");

  console.log(pc.yellow(
    "⚠ WARNING: Muavin runs Claude Code autonomously and may consume\n" +
    "significant API tokens. It can read/write files, run commands, and\n" +
    "access your data. Use at your own risk.\n"
  ));
  const consent = prompt('Type "yes" to proceed: ');
  if (consent?.toLowerCase() !== "yes") {
    console.log("Setup cancelled.");
    return;
  }
  console.log();

  heading("Setup inputs you'll need:");
  dim("- Telegram bot token + your Telegram user ID");
  dim("- Supabase project URL + service_role key");
  dim("- OpenAI API key");
  dim("- Cloudflare R2 bucket + endpoint + access key + secret");
  dim("- Anthropic API key (required for Claude-backed runtime)\n");
  dim("Fresh-start note: setup recreates ~/.muavin templates/jobs when missing.\n");

  // Step 1: Check prerequisites
  if (!await checkPrereqs()) {
    return;
  }

  // Check for existing config
  const homeDir = process.env.HOME!;
  const muavinDir = `${homeDir}/.muavin`;
  const envPath = `${muavinDir}/.env`;
  const configPath = `${muavinDir}/config.json`;

  const existingEnv = await parseEnvFile(envPath);
  const existingConfig = await parseConfigFile(configPath);

  // Step 2: Setup Telegram (or skip if already configured)
  let telegram = await checkExistingTelegram(existingEnv, existingConfig);
  if (!telegram) {
    telegram = await setupTelegram();
    if (!telegram) return;
    await updateEnvFile({ TELEGRAM_BOT_TOKEN: telegram.token });
    await updateMuavinConfig(telegram.userId);
  }

  // Step 3: Setup Supabase (or skip if already configured)
  let supabase = await checkExistingSupabase(existingEnv);
  if (!supabase) {
    supabase = await setupSupabase();
    if (!supabase) return;
    await updateEnvFile({ SUPABASE_URL: supabase.url, SUPABASE_SERVICE_KEY: supabase.key });
  }

  // Step 4: Setup OpenAI (or skip if already configured)
  let openaiKey = await checkExistingOpenAI(existingEnv);
  if (!openaiKey) {
    openaiKey = await setupOpenAI();
    if (!openaiKey) return;
    await updateEnvFile({ OPENAI_API_KEY: openaiKey });
  }
  process.env.OPENAI_API_KEY = openaiKey;

  // Step 5: Setup required R2 storage
  if (!await setupRequiredR2(existingEnv)) {
    return;
  }

  // Step 6: Setup Anthropic (or skip if already configured)
  let anthropicKey = existingEnv.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    ok("Anthropic already configured\n");
  } else {
    heading("Setting up Anthropic...");
    dim("1. Go to https://console.anthropic.com/settings/keys");
    dim("2. Create a new API key");
    dim("3. Copy the key\n");

    const key = prompt("Enter your Anthropic API key (press Enter to skip): ");
    if (key) {
      await updateEnvFile({ ANTHROPIC_API_KEY: key });
      ok("Anthropic key saved\n");
    } else {
      warn("Skipped — Claude Code requires ANTHROPIC_API_KEY to function\n");
    }
  }

  // Step 7: Optional API keys
  await setupOptionalKeys(existingEnv);

  // Step 8: Verify all services
  if (!await verifyAll()) {
    return;
  }

  // Step 9: Store repoPath
  const { resolve } = await import("path");
  const repoRoot = resolve(import.meta.dir, "..");
  try {
    const currentConfig = JSON.parse(await Bun.file(configPath).text());
    if (currentConfig.repoPath !== repoRoot) {
      currentConfig.repoPath = repoRoot;
      await Bun.write(configPath, JSON.stringify(currentConfig, null, 2) + "\n");
      ok("Updated repoPath in config");
    }
  } catch {}

  // Step 10: Install templates
  await installTemplates();

  // Step 11: Offer deploy
  const shouldStart = prompt("Start daemons now? (y/n): ");
  if (shouldStart?.toLowerCase() === "y") {
    await deployCommand();
  }

  console.log();
  ok("Setup complete!");
  heading("Next steps:");
  dim("- For immediate TUI writing tests: bun muavin write");
  dim("- To launch background services: bun muavin start");
}

async function parseEnvFile(envPath: string): Promise<Record<string, string>> {
  try {
    const file = Bun.file(envPath);
    if (!await file.exists()) {
      return {};
    }
    const content = await file.text();
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) {
        env[match[1]] = match[2];
      }
    }
    return env;
  } catch {
    return {};
  }
}

async function parseConfigFile(configPath: string): Promise<any> {
  try {
    const file = Bun.file(configPath);
    if (!await file.exists()) {
      return null;
    }
    return await file.json();
  } catch {
    return null;
  }
}

async function checkExistingTelegram(
  existingEnv: Record<string, string>,
  existingConfig: any
): Promise<{ token: string; userId: string } | null> {
  const token = existingEnv.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return null;
  }

  // Validate token
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json();
    if (!data.ok) {
      warn("Existing Telegram token is invalid, re-configuring...\n");
      return null;
    }

    // Get userId from config
    const userId = existingConfig?.owner?.toString();
    if (!userId || !/^\d+$/.test(userId)) {
      warn("Telegram token valid but user ID missing, re-configuring...\n");
      return null;
    }

    ok(`Telegram already configured (@${data.result.username})\n`);
    return { token, userId };
  } catch {
    warn("Could not validate existing Telegram token, re-configuring...\n");
    return null;
  }
}

async function checkExistingOpenAI(
  existingEnv: Record<string, string>
): Promise<string | null> {
  const key = existingEnv.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return null;

  try {
    await testEmbedding(key);
    ok("OpenAI already configured\n");
    return key;
  } catch {
    warn("Existing OpenAI key is invalid, re-configuring...\n");
    return null;
  }
}

function extractSupabaseProjectRef(url: string): string | null {
  const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return match?.[1] ?? null;
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (!Bun.which("pbcopy")) return false;
  try {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(text);
    proc.stdin.end();
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function openInBrowser(url: string): Promise<boolean> {
  if (!Bun.which("open")) return false;
  try {
    const proc = Bun.spawn(["open", url], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

async function promptSupabaseSchemaRun(projectRef: string): Promise<void> {
  const schemaPath = resolve(import.meta.dir, "..", "supabase-schema.sql");
  const schemaSql = await Bun.file(schemaPath).text();
  const sqlEditorUrl = `https://supabase.com/dashboard/project/${projectRef}/sql/new`;

  const copied = await copyToClipboard(schemaSql);
  const opened = await openInBrowser(sqlEditorUrl);

  console.log();
  if (copied) ok("Schema SQL copied to clipboard");
  else warn("Could not copy schema SQL to clipboard (common in SSH/headless sessions)");

  if (opened) ok("Opening SQL Editor in browser");
  else warn("Could not auto-open browser");

  dim(`SQL editor URL: ${sqlEditorUrl}`);
  dim(`Schema file: ${schemaPath}`);
  if (!copied) dim(`Copy manually: cat ${schemaPath}`);
  console.log();
  dim("Run the schema SQL in Supabase, then return here.");
  prompt("Press Enter when done...");
}

async function checkExistingSupabase(
  existingEnv: Record<string, string>
): Promise<{ url: string; key: string } | null> {
  const url = existingEnv.SUPABASE_URL;
  const key = existingEnv.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    return null;
  }

  // Test connection and check if tables exist
  const client = createClient(url, key);
  try {
    const { error } = await client.from("user_blocks").select("id").limit(1);

    if (error && (error.code === "42P01" || error.message?.includes("not find the table"))) {
      warn("Supabase credentials exist but tables not found, setting up schema...\n");

      const projectRef = extractSupabaseProjectRef(url);
      if (!projectRef) {
        fail("Could not extract project reference from URL");
        return null;
      }
      await promptSupabaseSchemaRun(projectRef);

      // Re-verify
      const { error: retryError } = await client.from("user_blocks").select("id").limit(1);
      if (retryError && (retryError.code === "42P01" || retryError.message?.includes("not find the table"))) {
        fail("Tables still not found");
        return null;
      }

      ok("Supabase connection verified\n");
      return { url, key };
    } else if (error) {
      warn("Supabase credentials exist but connection failed, re-configuring...\n");
      return null;
    }

    ok("Supabase already configured\n");
    return { url, key };
  } catch {
    warn("Could not validate existing Supabase credentials, re-configuring...\n");
    return null;
  }
}

async function checkPrereqs(): Promise<boolean> {
  heading("Checking prerequisites...");

  const bunPath = Bun.which("bun");
  if (!bunPath) {
    fail("bun not found");
    return false;
  }
  ok("bun found");

  const claudePath = Bun.which("claude");
  if (!claudePath) {
    fail("claude CLI not found");
    return false;
  }
  ok("claude CLI found");

  const nodeModulesExists = await Bun.file("node_modules/grammy/package.json").exists();
  if (!nodeModulesExists) {
    fail("node_modules not found - run: bun install");
    return false;
  }
  ok("node_modules found");

  const requiredBinaries = [
    { cmd: "aws", hint: "brew install awscli" },
    { cmd: "pdftotext", hint: "brew install poppler" },
    { cmd: "ffmpeg", hint: "brew install ffmpeg" },
  ];
  for (const dep of requiredBinaries) {
    if (!Bun.which(dep.cmd)) {
      fail(`${dep.cmd} not found (${dep.hint})`);
      return false;
    }
    ok(`${dep.cmd} found`);
  }

  // Check for claude-code-safety-net plugin
  try {
    const settingsPath = `${process.env.HOME}/.claude/settings.json`;
    const settingsFile = Bun.file(settingsPath);
    if (await settingsFile.exists()) {
      const settings = await settingsFile.json();
      const plugins = settings.enabledPlugins ?? {};
      const safetyNet = Object.entries(plugins).find(
        ([key]) => key.includes("safety-net")
      );
      if (safetyNet && safetyNet[1] === true) {
        ok("claude-code-safety-net found");
      } else {
        warn("claude-code-safety-net not installed");
        dim("Run in Claude Code: /plugin marketplace add kenryu42/cc-marketplace && /plugin install safety-net@cc-marketplace");
      }
    } else {
      warn("claude-code-safety-net not installed");
      dim("Run in Claude Code: /plugin marketplace add kenryu42/cc-marketplace && /plugin install safety-net@cc-marketplace");
    }
  } catch {
    // Non-blocking, skip if settings can't be read
  }

  console.log();
  return true;
}

async function setupTelegram(): Promise<{ token: string; userId: string } | null> {
  heading("Setting up Telegram...");
  dim("1. Open Telegram and message @BotFather");
  dim("2. Send /newbot and follow the prompts");
  dim("3. Copy the bot token\n");

  const token = prompt("Enter your Telegram bot token: ");
  if (!token) {
    fail("No token provided");
    return null;
  }

  // Validate token
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json();
    if (!data.ok) {
      fail("Invalid bot token");
      return null;
    }
    ok(`Bot validated: @${data.result.username}`);
  } catch (error) {
    fail("Failed to validate bot token");
    return null;
  }

  console.log("\nTo get your user ID:");
  dim("1. Message @userinfobot on Telegram");
  dim("2. Copy your ID\n");

  const userId = prompt("Enter your Telegram user ID: ");
  if (!userId || !/^\d+$/.test(userId)) {
    fail("Invalid user ID (must be numeric)");
    return null;
  }
  ok("User ID validated\n");

  return { token, userId };
}

async function setupOpenAI(): Promise<string | null> {
  heading("Setting up OpenAI...");
  dim("1. Go to https://platform.openai.com/api-keys");
  dim("2. Create a new API key");
  dim("3. Copy the key\n");

  const key = prompt("Enter your OpenAI API key: ");
  if (!key) {
    fail("No key provided");
    return null;
  }

  try {
    await testEmbedding(key);
    ok("OpenAI API verified\n");
    return key;
  } catch {
    fail("Invalid OpenAI API key");
    return null;
  }
}

async function setupOptionalKeys(existingEnv: Record<string, string>) {
  const optionalKeys = [
    { envVar: "XAI_API_KEY", name: "Grok (xAI)" },
    { envVar: "GEMINI_API_KEY", name: "Gemini (Google)" },
    { envVar: "OPENROUTER_API_KEY", name: "OpenRouter" },
    { envVar: "BRAVE_API_KEY", name: "Brave Search" },
  ];

  for (const { envVar, name } of optionalKeys) {
    if (existingEnv[envVar]) {
      ok(`${name} already configured`);
      continue;
    }

    const value = prompt(`Enter your ${name} API key (press Enter to skip): `);
    if (value) {
      await updateEnvFile({ [envVar]: value });
      ok(`${name} key saved`);
    }
  }
  console.log();
}

async function setupRequiredR2(existingEnv: Record<string, string>): Promise<boolean> {
  heading("Setting up Cloudflare R2 (required)...");
  dim("1. Cloudflare Dashboard → R2");
  dim("2. Create/select bucket");
  dim("3. Settings → S3 API → create access key");
  dim("4. Copy bucket name, S3 endpoint, access key ID, secret key\n");

  const required = [
    { envVar: "R2_BUCKET", name: "Cloudflare R2 bucket" },
    { envVar: "R2_ENDPOINT_URL", name: "Cloudflare R2 endpoint URL" },
    { envVar: "R2_ACCESS_KEY_ID", name: "Cloudflare R2 access key ID" },
    { envVar: "R2_SECRET_ACCESS_KEY", name: "Cloudflare R2 secret access key" },
  ] as const;

  const updates: Record<string, string> = {};

  for (const field of required) {
    const current = existingEnv[field.envVar] || process.env[field.envVar];
    if (current) {
      updates[field.envVar] = current;
      ok(`${field.name} already configured`);
      continue;
    }

    const promptText = field.envVar === "R2_SECRET_ACCESS_KEY"
      ? `Enter ${field.name}: `
      : `Enter ${field.name}: `;
    const value = prompt(promptText);
    if (!value) {
      fail(`${field.name} is required`);
      return false;
    }
    updates[field.envVar] = value;
  }

  await updateEnvFile(updates);
  ok("R2 configuration saved\n");
  return true;
}

async function setupSupabase(): Promise<{ url: string; key: string } | null> {
  heading("Setting up Supabase...");
  dim("1. Go to your Supabase project dashboard");
  dim("2. Settings → API → Project API keys");
  dim("3. Copy the 'service_role' key (the secret one, NOT anon)\n");

  const url = prompt("Enter your Supabase project URL (e.g., https://xxxx.supabase.co): ");
  if (!url) {
    fail("No URL provided");
    return null;
  }

  const key = prompt("Enter your Supabase service_role key: ");
  if (!key) {
    fail("No key provided");
    return null;
  }

  // Test connection
  const client = createClient(url, key);
  try {
    const { error } = await client.from("user_blocks").select("id").limit(1);

    if (error && (error.code === "42P01" || error.message?.includes("not find the table"))) {
      console.log();
      fail("Tables not found. Setting up schema...");

      const projectRef = extractSupabaseProjectRef(url);
      if (!projectRef) {
        fail("Could not extract project reference from URL");
        return null;
      }
      await promptSupabaseSchemaRun(projectRef);

      // Re-verify
      const { error: retryError } = await client.from("user_blocks").select("id").limit(1);
      if (retryError && (retryError.code === "42P01" || retryError.message?.includes("not find the table"))) {
        fail("Tables still not found");
        return null;
      }
    } else if (error) {
      fail(`Supabase connection error: ${error.message}`);
      return null;
    }

    ok("Supabase connection verified\n");
    return { url, key };
  } catch (error) {
    fail("Failed to connect to Supabase");
    return null;
  }
}

async function verifyAll(): Promise<boolean> {
  heading("Verifying services...");

  // Test OpenAI embeddings
  try {
    await testEmbedding(process.env.OPENAI_API_KEY!);
    ok("OpenAI API verified");
  } catch (error) {
    fail("OpenAI API failed");
    return false;
  }

  // Test Claude CLI
  try {
    const proc = Bun.spawn(["claude", "--version"]);
    await proc.exited;
    if (proc.exitCode === 0) {
      ok("Claude CLI verified");
    } else {
      fail("Claude CLI failed");
      return false;
    }
  } catch (error) {
    fail("Claude CLI failed");
    return false;
  }

  console.log();
  return true;
}

async function updateEnvFile(updates: Record<string, string>) {
  const homeDir = process.env.HOME!;
  const muavinDir = `${homeDir}/.muavin`;
  const envPath = `${muavinDir}/.env`;

  await mkdir(muavinDir, { recursive: true });

  // Read existing or create new .env content
  const examplePath = `${import.meta.dir}/../.env.example`;
  let content: string;
  if (await Bun.file(envPath).exists()) {
    content = await Bun.file(envPath).text();
  } else if (await Bun.file(examplePath).exists()) {
    content = await Bun.file(examplePath).text();
  } else {
    content = "";
  }

  const lines = content.split("\n");
  const foundKeys = new Set<string>();

  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Z_]+)=/);
    if (match && match[1] in updates) {
      foundKeys.add(match[1]);
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  // Append any keys that weren't found in the template
  for (const key in updates) {
    if (!foundKeys.has(key)) {
      // Find the last non-empty line
      let insertIndex = updatedLines.length;
      while (insertIndex > 0 && updatedLines[insertIndex - 1].trim() === "") {
        insertIndex--;
      }
      updatedLines.splice(insertIndex, 0, `${key}=${updates[key]}`);
    }
  }

  await Bun.write(envPath, updatedLines.join("\n"));
  ok(".env file updated");
}

async function updateMuavinConfig(userId: string) {
  const homeDir = process.env.HOME!;
  const muavinDir = `${homeDir}/.muavin`;
  const configPath = `${muavinDir}/config.json`;
  const examplePath = `${import.meta.dir}/../config.example.json`;

  await mkdir(muavinDir, { recursive: true });

  // Copy config.example.json to ~/.muavin/config.json
  const example = await Bun.file(examplePath).text();
  await Bun.write(configPath, example);
  ok("Created config.json from config.example.json");

  const config = JSON.parse(await Bun.file(configPath).text());
  const uid = Number(userId);
  config.owner = uid;
  if (!Array.isArray(config.allowUsers)) config.allowUsers = [];
  if (!config.allowUsers.includes(uid)) config.allowUsers.push(uid);
  if (!Array.isArray(config.allowGroups)) config.allowGroups = [];
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
  ok("config.json updated (owner + allowUsers)");
}

async function installTemplates() {
  const homeDir = process.env.HOME!;
  const muavinDir = `${homeDir}/.muavin`;
  const templatesDir = `${import.meta.dir}/../templates`;
  const docsDir = `${muavinDir}/docs`;
  const promptsDir = `${muavinDir}/prompts`;

  const systemDir = `${muavinDir}/system`;
  const outboxDir = `${muavinDir}/outbox`;
  const inboxFilesDir = `${muavinDir}/inbox/files`;

  await mkdir(docsDir, { recursive: true });
  await mkdir(promptsDir, { recursive: true });
  await mkdir(systemDir, { recursive: true });
  await mkdir(outboxDir, { recursive: true });
  await mkdir(inboxFilesDir, { recursive: true });

  // Remove legacy top-level CLAUDE.md; style instructions live in muavin.md
  const { unlink: unlinkFile } = await import("fs/promises");
  await unlinkFile(`${muavinDir}/CLAUDE.md`).catch(() => {});

  // Install muavin.md (always overwrite — identity file)
  try {
    const muavinMdContent = await Bun.file(`${templatesDir}/muavin.md`).text();
    await Bun.write(`${muavinDir}/muavin.md`, muavinMdContent);
    ok("Installed muavin.md");
  } catch {
    fail("Could not read templates/muavin.md");
  }

  // Install docs (always overwrite)
  const docFiles = ["behavior.md", "jobs.md", "agents.md", "skills.md"];
  for (const doc of docFiles) {
    try {
      const content = await Bun.file(`${templatesDir}/docs/${doc}`).text();
      await Bun.write(`${docsDir}/${doc}`, content);
    } catch {
      fail(`Could not read templates/docs/${doc}`);
    }
  }
  ok(`Installed docs/ (${docFiles.length} files)`);

  // Install prompts (always overwrite)
  const promptFiles = ["heartbeat-triage.md"];
  for (const promptFile of promptFiles) {
    try {
      const content = await Bun.file(`${templatesDir}/prompts/${promptFile}`).text();
      await Bun.write(`${promptsDir}/${promptFile}`, content);
    } catch {
      fail(`Could not read templates/prompts/${promptFile}`);
    }
  }
  ok(`Installed prompts/ (${promptFiles.length} files)`);

  // Remove stale prompt files that are not part of the active prompt set
  const { readdir: readDir, unlink: unlinkPromptFile } = await import("fs/promises");
  const allowedPromptFiles = new Set(promptFiles);
  const existingPromptFiles = await readDir(promptsDir).catch(() => []);
  for (const existingFile of existingPromptFiles) {
    if (existingFile.startsWith(".")) continue;
    if (!allowedPromptFiles.has(existingFile)) {
      await unlinkPromptFile(`${promptsDir}/${existingFile}`).catch(() => {});
    }
  }

  // Install system CLAUDE.md for worker agents (always overwrite)
  const systemClaudePath = `${systemDir}/CLAUDE.md`;
  await Bun.write(systemClaudePath, "You are a worker agent. Be concise. Return raw results.\n");
  ok("Installed system/CLAUDE.md");

  // Seed default jobs (merge, don't overwrite)
  const jobsPath = `${muavinDir}/jobs.json`;
  const { loadJson, saveJson } = await import("./utils");
  const existingJobs = await loadJson<Job[]>(jobsPath) ?? [];
  const seeded = seedDefaultJobs(existingJobs);
  const added = seeded.length - existingJobs.length;
  await saveJson(jobsPath, seeded);
  if (added > 0) {
    ok(`Seeded ${added} default job(s)`);
  } else {
    ok("Default jobs already present");
  }
}

function maskValue(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "..." + value.slice(-3);
}

type FieldType = "secret" | "number" | "boolean" | "select";

interface ConfigField {
  key: string;
  label: string;
  source: "env" | "config";
  type: FieldType;
  options?: string[];
}

interface ConfigSection {
  title: string;
  fields: ConfigField[];
}

const configSections: ConfigSection[] = [
  {
    title: "Services",
    fields: [
      { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", source: "env", type: "secret" },
      { key: "owner", label: "Telegram user ID", source: "config", type: "number" },
      { key: "SUPABASE_URL", label: "Supabase URL", source: "env", type: "secret" },
      { key: "SUPABASE_SERVICE_KEY", label: "Supabase service key", source: "env", type: "secret" },
    ],
  },
  {
    title: "API Keys",
    fields: [
      { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", source: "env", type: "secret" },
      { key: "OPENAI_API_KEY", label: "OpenAI API key", source: "env", type: "secret" },
      { key: "XAI_API_KEY", label: "Grok (xAI) API key", source: "env", type: "secret" },
      { key: "GEMINI_API_KEY", label: "Gemini API key", source: "env", type: "secret" },
      { key: "OPENROUTER_API_KEY", label: "OpenRouter API key", source: "env", type: "secret" },
      { key: "BRAVE_API_KEY", label: "Brave Search API key", source: "env", type: "secret" },
    ],
  },
  {
    title: "Storage",
    fields: [
      { key: "R2_BUCKET", label: "R2 bucket", source: "env", type: "secret" },
      { key: "R2_ENDPOINT_URL", label: "R2 endpoint URL", source: "env", type: "secret" },
      { key: "R2_ACCESS_KEY_ID", label: "R2 access key ID", source: "env", type: "secret" },
      { key: "R2_SECRET_ACCESS_KEY", label: "R2 secret access key", source: "env", type: "secret" },
    ],
  },
  {
    title: "Behavior",
    fields: [
      { key: "model", label: "Claude model", source: "config", type: "select", options: ["sonnet", "opus", "haiku"] },
      { key: "relayTimeoutMs", label: "Relay timeout (ms)", source: "config", type: "number" },
      { key: "relayMaxTurns", label: "Relay max turns", source: "config", type: "number" },
      { key: "jobTimeoutMs", label: "Job timeout (ms)", source: "config", type: "number" },
      { key: "jobMaxTurns", label: "Job max turns", source: "config", type: "number" },
      { key: "agentTimeoutMs", label: "Agent timeout (ms)", source: "config", type: "number" },
      { key: "agentMaxTurns", label: "Agent max turns", source: "config", type: "number" },
      { key: "startOnLogin", label: "Start on login", source: "config", type: "boolean" },
    ],
  },
];

function readKey(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (data: string) => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      if (data === "\x1b[A") resolve("up");
      else if (data === "\x1b[B") resolve("down");
      else if (data === "\r") resolve("enter");
      else if (data === "\x1b" || data === "q") resolve("escape");
      else if (data === "\x03") resolve("ctrl-c");
      else resolve(data);
    };
    process.stdin.on("data", onData);
  });
}

function getDisplayValue(field: ConfigField, env: Record<string, string>, config: any): string {
  if (field.type === "boolean") {
    const value = config?.[field.key];
    if (field.key === "startOnLogin") {
      return (value !== undefined ? value !== false : true) ? "on" : "off";
    }
    return value ? "on" : "off";
  }

  if (field.type === "select") {
    const value = config?.[field.key];
    if (field.key === "model") {
      return value ?? "opus";
    }
    return value ?? (field.options?.[0] ?? pc.dim("(not set)"));
  }

  if (field.source === "config") {
    const value = config?.[field.key];
    return value !== undefined ? value.toString() : pc.dim("(not set)");
  }

  const value = env[field.key];
  if (!value) return pc.dim("(not set)");
  return maskValue(value);
}

function renderMenu(env: Record<string, string>, config: any, cursor: number) {
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(pc.bold("Muavin Configuration"));
  console.log();

  let fieldIndex = 0;
  for (const section of configSections) {
    console.log(pc.bold(section.title));
    for (const field of section.fields) {
      const prefix = fieldIndex === cursor ? ">" : " ";
      const displayValue = getDisplayValue(field, env, config);
      const line = `${prefix} ${field.label.padEnd(26)} ${displayValue}`;
      if (fieldIndex === cursor) {
        console.log(pc.cyan(line));
      } else {
        console.log(line);
      }
      fieldIndex++;
    }
    console.log();
  }

  console.log(pc.dim("  ↑↓ navigate  Enter edit  Esc exit"));
}

async function editField(
  field: ConfigField,
  env: Record<string, string>,
  config: any,
  envPath: string,
  configPath: string
) {
  if (field.type === "boolean") {
    const currentConfig = await parseConfigFile(configPath) ?? {};
    const currentValue = currentConfig[field.key];
    if (field.key === "startOnLogin") {
      const newValue = !(currentValue !== undefined ? currentValue !== false : true);
      currentConfig[field.key] = newValue;
      config[field.key] = newValue;
    } else {
      const newValue = !currentValue;
      currentConfig[field.key] = newValue;
      config[field.key] = newValue;
    }
    await Bun.write(configPath, JSON.stringify(currentConfig, null, 2) + "\n");
    return;
  }

  if (field.type === "select" && field.options) {
    const currentConfig = await parseConfigFile(configPath) ?? {};
    const currentValue = currentConfig[field.key] ?? (field.key === "model" ? "opus" : field.options[0]);
    const currentIndex = field.options.indexOf(currentValue);
    const nextIndex = (currentIndex + 1) % field.options.length;
    const newValue = field.options[nextIndex];
    currentConfig[field.key] = newValue;
    config[field.key] = newValue;
    await Bun.write(configPath, JSON.stringify(currentConfig, null, 2) + "\n");
    return;
  }

  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\x1b[?25h");

  const currentValue = field.source === "config"
    ? (config?.[field.key]?.toString() ?? "")
    : (env[field.key] ?? "");

  if (currentValue) {
    const displayCurrent = field.type === "secret" ? maskValue(currentValue) : currentValue;
    console.log(`\nCurrent: ${displayCurrent}`);
  }

  const newValue = prompt("New value (Enter to cancel): ");
  if (!newValue) return;

  if (field.key === "TELEGRAM_BOT_TOKEN") {
    try {
      const response = await fetch(`https://api.telegram.org/bot${newValue}/getMe`);
      const data = await response.json();
      if (!data.ok) {
        fail("Invalid bot token");
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
      }
      ok(`Bot validated: @${data.result.username}`);
    } catch {
      fail("Failed to validate bot token");
      await new Promise(resolve => setTimeout(resolve, 1000));
      return;
    }
  }

  if (field.key === "SUPABASE_URL" || field.key === "SUPABASE_SERVICE_KEY") {
    const url = field.key === "SUPABASE_URL" ? newValue : env.SUPABASE_URL;
    const key = field.key === "SUPABASE_SERVICE_KEY" ? newValue : env.SUPABASE_SERVICE_KEY;
    if (url && key) {
      try {
        const client = createClient(url, key);
        const { error } = await client.from("user_blocks").select("id").limit(1);
        if (error) {
          fail(`Supabase error: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          return;
        }
        ok("Supabase connection verified");
      } catch {
        fail("Failed to connect to Supabase");
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
      }
    }
  }

  if (field.key === "OPENAI_API_KEY") {
    try {
      await testEmbedding(newValue);
      ok("OpenAI API verified");
    } catch {
      fail("Invalid OpenAI API key");
      await new Promise(resolve => setTimeout(resolve, 1000));
      return;
    }
  }

  if (field.source === "config") {
    const currentConfig = await parseConfigFile(configPath) ?? {};
    if (field.key === "owner") {
      const uid = Number(newValue);
      if (isNaN(uid)) {
        fail("Must be numeric");
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
      }
      currentConfig.owner = uid;
      if (!Array.isArray(currentConfig.allowUsers)) currentConfig.allowUsers = [];
      if (!currentConfig.allowUsers.includes(uid)) currentConfig.allowUsers.push(uid);
    } else if (field.type === "number") {
      const num = Number(newValue);
      if (isNaN(num) || num <= 0) {
        fail("Must be a positive number");
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
      }
      currentConfig[field.key] = num;
    } else {
      currentConfig[field.key] = newValue;
    }
    await Bun.write(configPath, JSON.stringify(currentConfig, null, 2) + "\n");
    config[field.key] = field.key === "owner" ? Number(newValue) :
                        field.type === "number" ? Number(newValue) : newValue;
  } else {
    await updateEnvFile({ [field.key]: newValue });
    env[field.key] = newValue;
  }
}

async function configCommand() {
  const homeDir = process.env.HOME!;
  const muavinDir = `${homeDir}/.muavin`;
  const envPath = `${muavinDir}/.env`;
  const configPath = `${muavinDir}/config.json`;

  // Check for --reset flag
  if (Bun.argv[3] === "--reset") {
    await resetConfig(configPath);
    return;
  }

  const env = await parseEnvFile(envPath);
  const config = await parseConfigFile(configPath) ?? {};

  const fields: ConfigField[] = configSections.flatMap(s => s.fields);
  let cursor = 0;

  const restoreTerminal = () => {
    process.stdout.write("\x1b[?25h");
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };

  process.on("SIGINT", () => {
    restoreTerminal();
    process.exit(0);
  });

  while (true) {
    renderMenu(env, config, cursor);
    const key = await readKey();

    if (key === "up") {
      cursor = (cursor - 1 + fields.length) % fields.length;
    } else if (key === "down") {
      cursor = (cursor + 1) % fields.length;
    } else if (key === "enter") {
      await editField(fields[cursor], env, config, envPath, configPath);
    } else if (key === "escape" || key === "ctrl-c") {
      restoreTerminal();
      return;
    }
  }
}

async function resetConfig(configPath: string) {
  // Read current config to preserve owner/allowUsers
  const currentConfig = await parseConfigFile(configPath);
  const owner = currentConfig?.owner;
  const allowUsers = currentConfig?.allowUsers;

  // Prompt for confirmation
  console.log(pc.yellow("⚠ This will reset all config settings to defaults."));
  console.log(pc.yellow("  Your owner and allowUsers will be preserved.\n"));
  const confirm = prompt('Type "yes" to proceed: ');
  if (confirm?.toLowerCase() !== "yes") {
    console.log("Reset cancelled.");
    return;
  }

  // Load defaults from config.example.json
  const examplePath = `${import.meta.dir}/../config.example.json`;
  const defaults = JSON.parse(await Bun.file(examplePath).text());

  // Preserve owner/allowUsers if they exist
  if (owner !== undefined) defaults.owner = owner;
  if (allowUsers !== undefined) defaults.allowUsers = allowUsers;

  // Write updated config
  await Bun.write(configPath, JSON.stringify(defaults, null, 2) + "\n");
  ok("Configuration reset to defaults");

  // Show what was preserved
  if (owner !== undefined) {
    console.log(pc.dim(`  Preserved owner: ${owner}`));
  }
  if (allowUsers !== undefined && allowUsers.length > 0) {
    console.log(pc.dim(`  Preserved allowUsers: ${allowUsers.join(", ")}`));
  }
}

async function stopCommand() {
  heading("Stopping Muavin daemons...\n");
  const { waitForUnload, STOPPED_MARKER, getUid } = await import("./utils");
  await Bun.write(STOPPED_MARKER, "");

  const uid = await getUid();

  const labels = ["ai.muavin.relay", "ai.muavin.heartbeat", "ai.muavin.cron"];

  for (const label of labels) {
    const proc = Bun.spawn(["launchctl", "bootout", `gui/${uid}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    if (proc.exitCode === 0) {
      await waitForUnload(label);
      ok(`Stopped ${label}`);
    } else if (proc.exitCode === 3) {
      dim(`  ${label} not loaded`);
    } else {
      dim(`  ${label} not loaded`);
    }
  }

  // Stop all job plists
  const jobListProc = Bun.spawn(["launchctl", "list"], { stdout: "pipe" });
  const jobListOutput = await new Response(jobListProc.stdout).text();
  const jobLabels = jobListOutput
    .split("\n")
    .filter((line) => line.includes("ai.muavin.job."))
    .map((line) => line.trim().split(/\s+/).pop()!)
    .filter(Boolean);

  const homeDir = process.env.HOME!;
  for (const label of jobLabels) {
    const jobProc = Bun.spawn(["launchctl", "bootout", `gui/${uid}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await jobProc.exited;
    if (jobProc.exitCode === 0) await waitForUnload(label);
    ok(`Stopped ${label}`);

    // Delete plist file
    const plistFile = `${homeDir}/Library/LaunchAgents/${label}.plist`;
    const { unlink: unlinkFile } = await import("fs/promises");
    await unlinkFile(plistFile).catch(() => {});
  }

  // Clean up lock file
  const lockPath = `${process.env.HOME}/.muavin/relay.lock`;
  try {
    const { unlink } = await import("fs/promises");
    await unlink(lockPath);
    ok("Removed relay.lock");
  } catch {
    // Lock file doesn't exist, that's fine
  }

  console.log();
  ok("All daemons stopped.");
}

async function deployCommand() {
  heading("Deploying...\n");
  const { reloadService, STOPPED_MARKER, getUid } = await import("./utils");
  const { unlink: unlinkFile } = await import("fs/promises");
  await unlinkFile(STOPPED_MARKER).catch(() => {});

  const homeDir = process.env.HOME!;

  // Validate required env vars before building
  const envPath = `${homeDir}/.muavin/.env`;
  const envVars = await parseEnvFile(envPath);
  const requiredKeys = [
    "TELEGRAM_BOT_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_KEY",
    "OPENAI_API_KEY",
    "R2_BUCKET",
    "R2_ENDPOINT_URL",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ];
  const missing = requiredKeys.filter((k) => !envVars[k]);
  if (missing.length > 0) {
    fail(`Missing required env vars: ${missing.join(", ")}\nCheck ~/.muavin/.env`);
    return;
  }

  const config = await parseConfigFile(`${homeDir}/.muavin/config.json`) ?? {};

  await installTemplates();

  const repoRoot = resolve(import.meta.dir, "..");
  const bunPath = Bun.which("bun");
  if (!bunPath) {
    fail("bun not found in PATH");
    return;
  }

  // Deploy launch daemons
  heading("Deploying launch daemons...");

  const uid = await getUid();

  const plists = [
    { file: "ai.muavin.relay.plist", label: "ai.muavin.relay" },
    { file: "ai.muavin.heartbeat.plist", label: "ai.muavin.heartbeat" },
  ];

  const launchAgentsDir = `${homeDir}/Library/LaunchAgents`;

  for (const { file, label } of plists) {
    const sourcePath = `${repoRoot}/daemon/${file}`;
    const destPath = `${launchAgentsDir}/${file}`;

    let plistContent = await Bun.file(sourcePath).text();
    const startOnLogin = config.startOnLogin !== false;
    plistContent = plistContent
      .replace(/__BUN__/g, bunPath)
      .replace(/__REPO_ROOT__/g, repoRoot)
      .replace(/__HOME__/g, homeDir)
      .replace(/__RUN_AT_LOAD__/g, startOnLogin ? "<true/>" : "<false/>");

    await Bun.write(destPath, plistContent);
    ok(`Copied ${file}`);

    const result = await reloadService(uid, label, destPath);
    if (result.ok) {
      ok(`Loaded ${label}`);
    } else {
      fail(`Failed to load ${label} (exit ${result.exitCode})`);
    }
  }

  // Sync job plists
  try {
    const { syncJobPlists } = await import("./jobs");
    await syncJobPlists();
    ok("Synced job plists");
  } catch (e) {
    warn(`Job plist sync failed: ${e instanceof Error ? e.message : e}`);
  }

  console.log();
  heading("Verifying deployment...");
  const listProc = Bun.spawn(["launchctl", "list"], { stdout: "pipe" });
  const output = await new Response(listProc.stdout).text();
  const muavinServices = output
    .split("\n")
    .filter((line) => line.includes("muavin"));

  if (muavinServices.length > 0) {
    ok("Active services:");
    muavinServices.forEach((line) => console.log(pc.dim(`  ${line}`)));
  } else {
    fail("No muavin services found");
  }
}

async function statusCommand() {
  const { timeAgo } = await import("./utils");
  heading("Muavin Status\n");

  // Check daemons
  heading("Daemons:");
  const listProc = Bun.spawn(["launchctl", "list"], { stdout: "pipe" });
  const output = await new Response(listProc.stdout).text();
  const muavinServices = output
    .split("\n")
    .filter((line) => line.includes("muavin"));

  if (muavinServices.length > 0) {
    muavinServices.forEach((line) => console.log(pc.dim(`  ${line}`)));
  } else {
    dim("  No muavin services running");
  }

  // Check sessions
  console.log();
  heading("Sessions:");
  const sessionsPath = `${process.env.HOME}/.muavin/sessions.json`;
  try {
    const sessionsFile = Bun.file(sessionsPath);
    if (await sessionsFile.exists()) {
      const sessions = await sessionsFile.json();
      for (const [chatId, session] of Object.entries(sessions) as [string, any][]) {
        const sessionId = session.sessionId ? session.sessionId.slice(0, 8) + "..." : "none";
        console.log(pc.dim(`  Chat ${chatId}: ${sessionId} (${session.updatedAt ?? "unknown"})`));
      }
    } else {
      dim("  No sessions file");
    }
  } catch {
    console.error(pc.dim("  Error reading sessions"));
  }

  // Check heartbeat
  console.log();
  heading("Heartbeat:");
  const heartbeatStatePath = `${process.env.HOME}/.muavin/heartbeat-state.json`;
  try {
    const heartbeatFile = Bun.file(heartbeatStatePath);
    if (await heartbeatFile.exists()) {
      const hbState = await heartbeatFile.json();
      const lastRun = hbState.lastRun ? new Date(hbState.lastRun).toLocaleString() : "never";
      const lastAlert = hbState.lastAlertAt ? new Date(hbState.lastAlertAt).toLocaleString() : "none";
      console.log(pc.dim(`  Last run: ${lastRun}`));
      console.log(pc.dim(`  Last alert: ${lastAlert}`));
    } else {
      dim("  No heartbeat state file");
    }
  } catch {
    console.error(pc.dim("  Error reading heartbeat state"));
  }

  // Check jobs
  console.log();
  heading("Jobs:");
  try {
    const { loadJson, MUAVIN_DIR: muavinDir } = await import("./utils");
    const jobsPath = `${muavinDir}/jobs.json`;
    const allJobs = await loadJson<Job[]>(jobsPath);

    if (!allJobs || allJobs.length === 0) {
      dim("  No jobs configured");
    } else {
      const enabled = allJobs.filter(j => j.enabled);
      const disabled = allJobs.filter(j => !j.enabled);
      console.log(pc.dim(`  ${enabled.length} enabled${disabled.length > 0 ? `, ${disabled.length} disabled` : ""}`));
      console.log();

      // Load job state
      const jobStatePath = `${muavinDir}/job-state.json`;
      let jobState: Record<string, number> = {};
      try {
        jobState = JSON.parse(await readFile(jobStatePath, "utf-8"));
      } catch {}

      // Get loaded job plists
      const launchListProc = Bun.spawn(["launchctl", "list"], { stdout: "pipe" });
      const launchListOutput = await new Response(launchListProc.stdout).text();
      const loadedJobLabels = new Set(
        launchListOutput.split("\n")
          .filter(l => l.includes("ai.muavin.job."))
          .map(l => l.trim().split(/\s+/).pop()!)
      );

      for (const job of allJobs) {
        const lastRun = jobState[job.id];
        const lastStr = lastRun ? timeAgo(lastRun) : "never";
        const typeStr = job.type === "system" ? pc.cyan("[sys]") : job.type === "default" ? pc.blue("[def]") : "     ";
        const statusStr = job.enabled ? pc.green("[on] ") : pc.yellow("[off]");
        let nextStr = "—";
        if (job.enabled) {
          try {
            const cron = new Cron(job.schedule);
            const nextRun = cron.nextRun();
            nextStr = nextRun ? timeUntil(nextRun.getTime()) : "—";
          } catch {
            nextStr = pc.red("invalid schedule");
          }
        }
        const loadedStr = job.enabled
          ? loadedJobLabels.has(`ai.muavin.job.${job.id}`) ? pc.green("[loaded]") : pc.red("[not loaded]")
          : "";
        const modelStr = job.model ? pc.magenta(`[${job.model}]`) : pc.dim("[default]");
        const name = (job.name || job.id).padEnd(20);
        const scheduleStr = job.schedule.padEnd(18);
        console.log(pc.dim(`  ${typeStr} ${statusStr} ${name} ${modelStr} ${scheduleStr} last: ${lastStr.padEnd(10)} next: ${nextStr}`) + (loadedStr ? ` ${loadedStr}` : ""));
        if (job.description) console.log(pc.dim(`             ${job.description}`));
      }
    }
  } catch {
    dim("  Error reading jobs");
  }

  // Check agents
  console.log();
  heading("Agents:");
  try {
    const running = await listAgents({ status: "running" });
    const completed = await listAgents({ status: "completed" });
    const pending = await listAgents({ status: "pending" });
    const failed = await listAgents({ status: "failed" });

    if (running.length === 0 && completed.length === 0 && pending.length === 0 && failed.length === 0) {
      dim("  No agents");
    } else {
      if (pending.length > 0) {
        for (const a of pending) {
          const modelTag = a.model ? ` [${a.model}]` : "";
          console.log(pc.dim(`  ${pc.yellow("pending")}   ${a.task}${modelTag} (created ${timeAgo(new Date(a.createdAt).getTime())})`));
          if (a.description) console.log(pc.dim(`             ${a.description}`));
        }
      }
      if (running.length > 0) {
        for (const a of running) {
          const elapsed = a.startedAt ? timeAgo(new Date(a.startedAt).getTime()) : "?";
          const modelTag = a.model ? ` [${a.model}]` : "";
          console.log(pc.dim(`  ${pc.cyan("running")}   ${a.task}${modelTag} (started ${elapsed})`));
          if (a.description) console.log(pc.dim(`             ${a.description}`));
        }
      }
      const recentCompleted = completed.slice(-5).reverse();
      if (recentCompleted.length > 0) {
        for (const a of recentCompleted) {
          const when = a.completedAt ? timeAgo(new Date(a.completedAt).getTime()) : "?";
          const modelTag = a.model ? ` [${a.model}]` : "";
          console.log(pc.dim(`  ${pc.green("done")}      ${a.task}${modelTag} (${when})`));
          if (a.description) console.log(pc.dim(`             ${a.description}`));
        }
      }
      const recentFailed = failed.slice(-3).reverse();
      if (recentFailed.length > 0) {
        for (const a of recentFailed) {
          const when = a.completedAt ? timeAgo(new Date(a.completedAt).getTime()) : "?";
          const modelTag = a.model ? ` [${a.model}]` : "";
          console.log(pc.dim(`  ${pc.red("failed")}    ${a.task}${modelTag} (${when})`));
          if (a.description) console.log(pc.dim(`             ${a.description}`));
        }
      }
    }
  } catch {
    dim("  Error reading agents");
  }

  // Check outbox
  console.log();
  heading("Outbox:");
  try {
    const { readOutbox } = await import("./utils");
    const items = await readOutbox();
    if (items.length === 0) {
      dim("  Empty");
    } else {
      for (const item of items) {
        const when = timeAgo(new Date(item.createdAt).getTime());
        const preview = item.result.slice(0, 60).replace(/\n/g, " ");
        console.log(pc.dim(`  [${item.source}] ${item.task ?? ""} — ${when} — ${preview}...`));
      }
    }
  } catch {
    dim("  Error reading outbox");
  }
}

function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff < 0) return "overdue";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

async function agentCommand() {
  const subcommand = Bun.argv[3];

  if (subcommand !== "create") {
    heading("Muavin Agent\n");
    console.log("Usage: bun muavin agent <command>\n");
    console.log("Commands:");
    console.log("  create  - Create a background agent");
    return;
  }

  // Parse args
  const args = Bun.argv.slice(4);
  let task = "";
  let agentPrompt = "";
  let chatId = 0;

  let model = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task" && args[i + 1]) task = args[++i];
    else if (args[i] === "--prompt" && args[i + 1]) agentPrompt = args[++i];
    else if (args[i] === "--chat-id" && args[i + 1]) chatId = Number(args[++i]);
    else if (args[i] === "--model" && args[i + 1]) model = args[++i];
  }

  if (!task || !agentPrompt || !chatId) {
    fail("Usage: bun muavin agent create --task \"...\" --prompt \"...\" --chat-id <id> [--model <model>]");
    return;
  }

  const { createAgent } = await import("./agents");
  const agent = await createAgent({ task, prompt: agentPrompt, chatId, ...(model && { model }) });
  ok(`Created agent ${agent.id}: ${agent.task}`);
  dim("  Relay will pick it up automatically");
}

async function testCommand() {
  heading("Running smoke tests...\n");

  const { validateEnv } = await import("./env");
  validateEnv();

  // Test block storage and retrieval
  heading("Testing block storage...");
  let insertedId = "";
  try {
    const { createUserBlock, searchRelatedBlocks } = await import("./blocks");
    const { supabase } = await import("./db");
    const created = await createUserBlock({
      rawContent: "cli-test block round-trip",
      source: "cli",
      sourceRef: { test: true },
      metadata: { test: true },
    });
    insertedId = created.id;

    const results = await searchRelatedBlocks({ query: "cli-test block round-trip", scope: "all", limit: 5 });
    if (results.length > 0) {
      ok("Block round-trip successful");
    } else {
      fail("Block search returned no results");
    }

    if (insertedId) {
      await supabase.from("user_blocks").delete().eq("id", insertedId);
    }
  } catch (error) {
    fail(`Block storage test failed: ${error}`);
  }

  // Test Telegram
  heading("Testing Telegram...");
  try {
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
    const me = await bot.api.getMe();
    ok(`Telegram bot: @${me.username}`);
  } catch (error) {
    fail(`Telegram test failed: ${error}`);
  }

  // Test jobs config
  heading("Testing jobs config...");
  try {
    const { loadJson, MUAVIN_DIR: muavinDir } = await import("./utils");
    const jobs = await loadJson<Array<{ id: string; schedule: string; enabled: boolean }>>(
      `${muavinDir}/jobs.json`
    );
    if (jobs && jobs.length > 0 && jobs.every((job: any) => job.id && job.schedule)) {
      ok(`Jobs config valid (${jobs.length} jobs)`);
    } else {
      fail("Jobs config invalid or empty");
    }
  } catch (error) {
    fail(`Jobs test failed: ${error}`);
  }
}

main();

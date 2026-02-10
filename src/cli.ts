import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { Bot } from "grammy";
import { resolve } from "path";
import { mkdir } from "fs/promises";
import pc from "picocolors";

const ok = (msg: string) => console.log(pc.green(`✓ ${msg}`));
const fail = (msg: string) => console.error(pc.red(`✗ ${msg}`));
const warn = (msg: string) => console.log(pc.yellow(`⚠ ${msg}`));
const heading = (msg: string) => console.log(pc.bold(msg));
const dim = (msg: string) => console.log(pc.dim(msg));

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
    default:
      heading("Muavin CLI\n");
      console.log("Usage: bun muavin <command>\n");
      console.log("Commands:");
      console.log("  setup   - Interactive setup wizard");
      console.log("  config  - Edit configuration");
      console.log("  start   - Deploy launch daemons");
      console.log("  stop    - Stop all daemons");
      console.log("  status  - Check daemon and session status");
      console.log("  test    - Run smoke tests");
      process.exit(0);
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

  // Step 5: Setup Anthropic (or skip if already configured)
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

  // Step 6: Optional API keys
  await setupOptionalKeys(existingEnv);

  // Step 7: Verify all services
  if (!await verifyAll()) {
    return;
  }

  // Step 8: Finalize
  await copyCLAUDEmd();

  // Step 9: Offer deploy
  const shouldStart = prompt("Start daemons now? (y/n): ");
  if (shouldStart?.toLowerCase() === "y") {
    await deployCommand();
  }

  console.log();
  ok("Setup complete!");
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
    const openai = new OpenAI({ apiKey: key });
    await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: "test",
    });
    ok("OpenAI already configured\n");
    return key;
  } catch {
    warn("Existing OpenAI key is invalid, re-configuring...\n");
    return null;
  }
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
    const { error } = await client.from("messages").select("id").limit(1);

    if (error && (error.code === "42P01" || error.message?.includes("not find the table"))) {
      warn("Supabase credentials exist but tables not found, setting up schema...\n");

      // Extract project ref from URL
      const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
      if (!match) {
        fail("Could not extract project reference from URL");
        return null;
      }
      const projectRef = match[1];

      // Copy schema SQL to clipboard and open SQL editor
      const schemaPath = resolve(import.meta.dir, "..", "supabase-schema.sql");
      const schemaSql = await Bun.file(schemaPath).text();
      const pbcopy = Bun.spawn(["pbcopy"], { stdin: "pipe" });
      pbcopy.stdin.write(schemaSql);
      pbcopy.stdin.end();
      await pbcopy.exited;

      const sqlEditorUrl = `https://supabase.com/dashboard/project/${projectRef}/sql/new`;
      Bun.spawn(["open", sqlEditorUrl]);

      ok("Schema SQL copied to clipboard");
      ok("Opening SQL Editor in browser");
      console.log("\nJust paste (⌘V) and click Run.\n");

      prompt("Press Enter when done...");

      // Re-verify
      const { error: retryError } = await client.from("messages").select("id").limit(1);
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
    const openai = new OpenAI({ apiKey: key });
    await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: "test",
    });
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
    const { error } = await client.from("messages").select("id").limit(1);

    if (error && (error.code === "42P01" || error.message?.includes("not find the table"))) {
      console.log();
      fail("Tables not found. Setting up schema...");

      // Extract project ref from URL
      const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
      if (!match) {
        fail("Could not extract project reference from URL");
        return null;
      }
      const projectRef = match[1];

      // Copy schema SQL to clipboard and open SQL editor
      const schemaPath = resolve(import.meta.dir, "..", "supabase-schema.sql");
      const schemaSql = await Bun.file(schemaPath).text();
      const pbcopy = Bun.spawn(["pbcopy"], { stdin: "pipe" });
      pbcopy.stdin.write(schemaSql);
      pbcopy.stdin.end();
      await pbcopy.exited;

      const sqlEditorUrl = `https://supabase.com/dashboard/project/${projectRef}/sql/new`;
      Bun.spawn(["open", sqlEditorUrl]);

      console.log();
      ok("Schema SQL copied to clipboard");
      ok("Opening SQL Editor in browser");
      console.log("\nJust paste (⌘V) and click Run.\n");

      prompt("Press Enter when done...");

      // Re-verify
      const { error: retryError } = await client.from("messages").select("id").limit(1);
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
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: "test",
    });
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

async function copyCLAUDEmd() {
  const homeDir = process.env.HOME!;
  const muavinDir = `${homeDir}/.muavin`;
  const destPath = `${muavinDir}/CLAUDE.md`;

  // Only copy if it doesn't already exist
  if (await Bun.file(destPath).exists()) {
    ok("CLAUDE.md already exists");
    return;
  }

  const examplePath = `${import.meta.dir}/../CLAUDE.example.md`;
  const example = await Bun.file(examplePath).text();
  await Bun.write(destPath, example);
  ok("Created CLAUDE.md from CLAUDE.example.md");
}

function maskValue(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "..." + value.slice(-3);
}

async function configCommand() {
  const homeDir = process.env.HOME!;
  const muavinDir = `${homeDir}/.muavin`;
  const envPath = `${muavinDir}/.env`;
  const configPath = `${muavinDir}/config.json`;

  const env = await parseEnvFile(envPath);
  const config = await parseConfigFile(configPath);

  const fields = [
    { key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", source: "env" },
    { key: "owner", label: "Telegram user ID", source: "config" },
    { key: "SUPABASE_URL", label: "Supabase URL", source: "env" },
    { key: "SUPABASE_SERVICE_KEY", label: "Supabase service key", source: "env" },
    { key: "OPENAI_API_KEY", label: "OpenAI API key", source: "env" },
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", source: "env" },
    { key: "XAI_API_KEY", label: "Grok (xAI) API key", source: "env" },
    { key: "GEMINI_API_KEY", label: "Gemini API key", source: "env" },
    { key: "OPENROUTER_API_KEY", label: "OpenRouter API key", source: "env" },
    { key: "BRAVE_API_KEY", label: "Brave Search API key", source: "env" },
    { key: "claudeTimeoutMs", label: "Claude timeout (ms)", source: "config" },
    { key: "startOnLogin", label: "Start on login", source: "config" },
  ];

  while (true) {
    heading("\nMuavin Configuration\n");

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      let value: string;
      if (f.key === "startOnLogin") {
        const raw = config?.[f.key];
        value = (raw !== undefined ? raw !== false : true) ? "on" : "off";
      } else if (f.source === "config") {
        value = config?.[f.key]?.toString() ?? "";
      } else {
        value = env[f.key] ?? "";
      }
      const isBool = typeof config?.[f.key] === "boolean";
      const isNum = typeof config?.[f.key] === "number";
      const display = value ? (isBool || isNum ? value : maskValue(value)) : pc.dim("(not set)");
      console.log(`  ${i + 1}. ${f.label.padEnd(22)} ${display}`);
    }

    console.log();
    const choice = prompt("Enter number to edit (or Enter to exit): ");
    if (!choice) break;

    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= fields.length) {
      warn("Invalid choice");
      continue;
    }

    const field = fields[idx];
    const newValue = prompt(`Enter new ${field.label}: `);
    if (!newValue) continue;

    // Validate where applicable
    if (field.key === "TELEGRAM_BOT_TOKEN") {
      try {
        const response = await fetch(`https://api.telegram.org/bot${newValue}/getMe`);
        const data = await response.json();
        if (!data.ok) { fail("Invalid bot token"); continue; }
        ok(`Bot validated: @${data.result.username}`);
      } catch { fail("Failed to validate bot token"); continue; }
    }

    if (field.key === "SUPABASE_URL" || field.key === "SUPABASE_SERVICE_KEY") {
      const url = field.key === "SUPABASE_URL" ? newValue : env.SUPABASE_URL;
      const key = field.key === "SUPABASE_SERVICE_KEY" ? newValue : env.SUPABASE_SERVICE_KEY;
      if (url && key) {
        try {
          const client = createClient(url, key);
          const { error } = await client.from("messages").select("id").limit(1);
          if (error) { fail(`Supabase error: ${error.message}`); continue; }
          ok("Supabase connection verified");
        } catch { fail("Failed to connect to Supabase"); continue; }
      }
    }

    if (field.key === "OPENAI_API_KEY") {
      try {
        const openai = new OpenAI({ apiKey: newValue });
        await openai.embeddings.create({ model: "text-embedding-3-small", input: "test" });
        ok("OpenAI API verified");
      } catch { fail("Invalid OpenAI API key"); continue; }
    }

    // Save the value
    if (field.source === "config") {
      const currentConfig = await parseConfigFile(configPath) ?? {};
      if (field.key === "owner") {
        const uid = Number(newValue);
        if (isNaN(uid)) { fail("Must be numeric"); continue; }
        currentConfig.owner = uid;
        if (!Array.isArray(currentConfig.allowUsers)) currentConfig.allowUsers = [];
        if (!currentConfig.allowUsers.includes(uid)) currentConfig.allowUsers.push(uid);
      } else if (field.key === "claudeTimeoutMs") {
        const ms = Number(newValue);
        if (isNaN(ms) || ms <= 0) { fail("Must be a positive number"); continue; }
        currentConfig.claudeTimeoutMs = ms;
      } else if (field.key === "startOnLogin") {
        if (newValue !== "true" && newValue !== "false") { fail("Must be true or false"); continue; }
        currentConfig.startOnLogin = newValue === "true";
      } else {
        currentConfig[field.key] = newValue;
      }
      await Bun.write(configPath, JSON.stringify(currentConfig, null, 2) + "\n");
      config[field.key] = newValue;
    } else {
      await updateEnvFile({ [field.key]: newValue });
      env[field.key] = newValue;
    }

    ok(`${field.label} updated`);
  }
}

async function stopCommand() {
  heading("Stopping Muavin daemons...\n");

  const uidProc = Bun.spawn(["id", "-u"], { stdout: "pipe" });
  const uid = (await new Response(uidProc.stdout).text()).trim();

  const labels = ["ai.muavin.relay", "ai.muavin.cron", "ai.muavin.heartbeat"];

  for (const label of labels) {
    const proc = Bun.spawn(["launchctl", "bootout", `gui/${uid}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    if (proc.exitCode === 0) {
      ok(`Stopped ${label}`);
    } else if (proc.exitCode === 3) {
      dim(`  ${label} not loaded`);
    } else {
      dim(`  ${label} not loaded`);
    }
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

  const homeDir = process.env.HOME!;

  // Validate required env vars before building
  const envPath = `${homeDir}/.muavin/.env`;
  const envVars = await parseEnvFile(envPath);
  const requiredKeys = ["TELEGRAM_BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "OPENAI_API_KEY"];
  const missing = requiredKeys.filter((k) => !envVars[k]);
  if (missing.length > 0) {
    fail(`Missing required env vars: ${missing.join(", ")}\nCheck ~/.muavin/.env`);
    return;
  }

  const config = await parseConfigFile(`${homeDir}/.muavin/config.json`) ?? {};

  const repoRoot = resolve(import.meta.dir, "..");
  const bunPath = Bun.which("bun");
  if (!bunPath) {
    fail("bun not found in PATH");
    return;
  }

  // Deploy launch daemons
  heading("Deploying launch daemons...");

  const uidProc = Bun.spawn(["id", "-u"]);
  const uid = (await new Response(uidProc.stdout).text()).trim();

  const plists = [
    { file: "ai.muavin.relay.plist", label: "ai.muavin.relay" },
    { file: "ai.muavin.cron.plist", label: "ai.muavin.cron" },
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

    await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${label}`], {
      stdout: "pipe",
      stderr: "pipe",
    }).exited;

    const bootstrapProc = Bun.spawn([
      "launchctl", "bootstrap", `gui/${uid}`, destPath,
    ]);
    await bootstrapProc.exited;

    if (bootstrapProc.exitCode === 0) {
      ok(`Loaded ${label}`);
    } else {
      fail(`Failed to load ${label}`);
    }
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

  // Check cron state
  console.log();
  heading("Cron:");
  const cronStatePath = `${process.env.HOME}/.muavin/cron-state.json`;
  try {
    const cronFile = Bun.file(cronStatePath);
    if (await cronFile.exists()) {
      const cronState = await cronFile.json();
      for (const [jobId, timestamp] of Object.entries(cronState)) {
        const date = typeof timestamp === "number" ? new Date(timestamp as number).toLocaleString() : "never";
        console.log(pc.dim(`  ${jobId}: ${date}`));
      }
    } else {
      dim("  No cron state file");
    }
  } catch {
    console.error(pc.dim("  Error reading cron state"));
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
}

async function testCommand() {
  heading("Running smoke tests...\n");

  // Test memory
  heading("Testing memory...");
  try {
    const { logMessage, searchContext, supabase } = await import("./memory");
    await logMessage("user", "cli-test", "test");
    const results = await searchContext("cli-test");
    if (results.length > 0) {
      ok("Memory round-trip successful");
    } else {
      fail("Memory search returned no results");
    }
    await supabase.from("messages").delete().eq("chat_id", "test").eq("content", "cli-test");
  } catch (error) {
    fail(`Memory test failed: ${error}`);
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

  // Test cron config
  heading("Testing cron config...");
  try {
    const cronFile = Bun.file(`${process.env.HOME}/.muavin/config.json`);
    const config = await cronFile.json();
    if (
      Array.isArray(config.cron) &&
      config.cron.every((job: any) => job.id && job.schedule)
    ) {
      ok(`Cron config valid (${config.cron.length} jobs)`);
    } else {
      fail("Cron config invalid");
    }
  } catch (error) {
    fail(`Cron test failed: ${error}`);
  }
}

main();

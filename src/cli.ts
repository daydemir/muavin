import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { Bot } from "grammy";
import { resolve } from "path";
import { mkdir } from "fs/promises";

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
    default:
      console.log("Muavin CLI\n");
      console.log("Usage: bun muavin <command>\n");
      console.log("Commands:");
      console.log("  setup   - Interactive setup wizard");
      console.log("  start   - Deploy launch daemons");
      console.log("  status  - Check daemon and session status");
      console.log("  test    - Run smoke tests");
      process.exit(0);
  }
}

async function setupCommand() {
  console.log("🚀 Muavin Setup Wizard\n");

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
  }

  // Step 3: Setup Supabase (or skip if already configured)
  let supabase = await checkExistingSupabase(existingEnv);
  if (!supabase) {
    supabase = await setupSupabase();
    if (!supabase) return;
  }

  // Step 4: Verify all services
  if (!await verifyAll()) {
    return;
  }

  // Step 5: Update .env file and muavin.json
  await updateEnvFile(telegram, supabase);
  await updateMuavinConfig(telegram.userId);
  await copyCLAUDEmd();

  // Step 6: Offer deploy
  const shouldStart = prompt("Start daemons now? (y/n): ");
  if (shouldStart?.toLowerCase() === "y") {
    await deployCommand();
  }

  console.log("\n✓ Setup complete!");
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
      console.log("⚠ Existing Telegram token is invalid, re-configuring...\n");
      return null;
    }

    // Get userId from config
    const userId = existingConfig?.owner?.toString();
    if (!userId || !/^\d+$/.test(userId)) {
      console.log("⚠ Telegram token valid but user ID missing, re-configuring...\n");
      return null;
    }

    console.log(`✓ Telegram already configured (@${data.result.username})\n`);
    return { token, userId };
  } catch {
    console.log("⚠ Could not validate existing Telegram token, re-configuring...\n");
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
      console.log("⚠ Supabase credentials exist but tables not found, setting up schema...\n");

      // Extract project ref from URL
      const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
      if (!match) {
        console.log("✗ Could not extract project reference from URL");
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

      console.log("✓ Schema SQL copied to clipboard");
      console.log("✓ Opening SQL Editor in browser");
      console.log("\nJust paste (⌘V) and click Run.\n");

      prompt("Press Enter when done...");

      // Re-verify
      const { error: retryError } = await client.from("messages").select("id").limit(1);
      if (retryError && (retryError.code === "42P01" || retryError.message?.includes("not find the table"))) {
        console.log("✗ Tables still not found");
        return null;
      }

      console.log("✓ Supabase connection verified\n");
      return { url, key };
    } else if (error) {
      console.log("⚠ Supabase credentials exist but connection failed, re-configuring...\n");
      return null;
    }

    console.log("✓ Supabase already configured\n");
    return { url, key };
  } catch {
    console.log("⚠ Could not validate existing Supabase credentials, re-configuring...\n");
    return null;
  }
}

async function checkPrereqs(): Promise<boolean> {
  console.log("Checking prerequisites...");

  const bunPath = Bun.which("bun");
  if (!bunPath) {
    console.log("✗ bun not found");
    return false;
  }
  console.log("✓ bun found");

  const claudePath = Bun.which("claude");
  if (!claudePath) {
    console.log("✗ claude CLI not found");
    return false;
  }
  console.log("✓ claude CLI found");

  const nodeModulesExists = await Bun.file("node_modules/grammy/package.json").exists();
  if (!nodeModulesExists) {
    console.log("✗ node_modules not found - run: bun install");
    return false;
  }
  console.log("✓ node_modules found");

  console.log();
  return true;
}

async function setupTelegram(): Promise<{ token: string; userId: string } | null> {
  console.log("Setting up Telegram...");
  console.log("1. Open Telegram and message @BotFather");
  console.log("2. Send /newbot and follow the prompts");
  console.log("3. Copy the bot token\n");

  const token = prompt("Enter your Telegram bot token: ");
  if (!token) {
    console.log("✗ No token provided");
    return null;
  }

  // Validate token
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json();
    if (!data.ok) {
      console.log("✗ Invalid bot token");
      return null;
    }
    console.log(`✓ Bot validated: @${data.result.username}`);
  } catch (error) {
    console.log("✗ Failed to validate bot token");
    return null;
  }

  console.log("\nTo get your user ID:");
  console.log("1. Message @userinfobot on Telegram");
  console.log("2. Copy your ID\n");

  const userId = prompt("Enter your Telegram user ID: ");
  if (!userId || !/^\d+$/.test(userId)) {
    console.log("✗ Invalid user ID (must be numeric)");
    return null;
  }
  console.log("✓ User ID validated\n");

  return { token, userId };
}

async function setupSupabase(): Promise<{ url: string; key: string } | null> {
  console.log("Setting up Supabase...");
  console.log("1. Go to your Supabase project dashboard");
  console.log("2. Settings → API → Project API keys");
  console.log("3. Copy the 'service_role' key (the secret one, NOT anon)\n");

  const url = prompt("Enter your Supabase project URL (e.g., https://xxxx.supabase.co): ");
  if (!url) {
    console.log("✗ No URL provided");
    return null;
  }

  const key = prompt("Enter your Supabase service_role key: ");
  if (!key) {
    console.log("✗ No key provided");
    return null;
  }

  // Test connection
  const client = createClient(url, key);
  try {
    const { error } = await client.from("messages").select("id").limit(1);

    if (error && (error.code === "42P01" || error.message?.includes("not find the table"))) {
      console.log("\n✗ Tables not found. Setting up schema...");

      // Extract project ref from URL
      const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
      if (!match) {
        console.log("✗ Could not extract project reference from URL");
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

      console.log("\n✓ Schema SQL copied to clipboard");
      console.log("✓ Opening SQL Editor in browser");
      console.log("\nJust paste (⌘V) and click Run.\n");

      prompt("Press Enter when done...");

      // Re-verify
      const { error: retryError } = await client.from("messages").select("id").limit(1);
      if (retryError && (retryError.code === "42P01" || retryError.message?.includes("not find the table"))) {
        console.log("✗ Tables still not found");
        return null;
      }
    } else if (error) {
      console.log(`✗ Supabase connection error: ${error.message}`);
      return null;
    }

    console.log("✓ Supabase connection verified\n");
    return { url, key };
  } catch (error) {
    console.log("✗ Failed to connect to Supabase");
    return null;
  }
}

async function verifyAll(): Promise<boolean> {
  console.log("Verifying services...");

  // Test OpenAI embeddings
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: "test",
    });
    console.log("✓ OpenAI API verified");
  } catch (error) {
    console.log("✗ OpenAI API failed");
    return false;
  }

  // Test Claude CLI
  try {
    const proc = Bun.spawn(["claude", "--version"]);
    await proc.exited;
    if (proc.exitCode === 0) {
      console.log("✓ Claude CLI verified");
    } else {
      console.log("✗ Claude CLI failed");
      return false;
    }
  } catch (error) {
    console.log("✗ Claude CLI failed");
    return false;
  }

  console.log();
  return true;
}

async function updateEnvFile(
  telegram: { token: string; userId: string },
  supabase: { url: string; key: string }
) {
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

  const updates: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: telegram.token,
    SUPABASE_URL: supabase.url,
    SUPABASE_SERVICE_KEY: supabase.key,
  };

  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Z_]+)=/);
    if (match && match[1] in updates) {
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

  await Bun.write(envPath, updatedLines.join("\n"));
  console.log("✓ .env file updated");
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
  console.log("✓ Created config.json from config.example.json");

  const config = JSON.parse(await Bun.file(configPath).text());
  const uid = Number(userId);
  config.owner = uid;
  if (!Array.isArray(config.allowUsers)) config.allowUsers = [];
  if (!config.allowUsers.includes(uid)) config.allowUsers.push(uid);
  if (!Array.isArray(config.allowGroups)) config.allowGroups = [];
  await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log("✓ config.json updated (owner + allowUsers)");
}

async function copyCLAUDEmd() {
  const homeDir = process.env.HOME!;
  const muavinDir = `${homeDir}/.muavin`;
  const destPath = `${muavinDir}/CLAUDE.md`;

  // Only copy if it doesn't already exist
  if (await Bun.file(destPath).exists()) {
    console.log("✓ CLAUDE.md already exists");
    return;
  }

  const examplePath = `${import.meta.dir}/../CLAUDE.example.md`;
  const example = await Bun.file(examplePath).text();
  await Bun.write(destPath, example);
  console.log("✓ Created CLAUDE.md from CLAUDE.example.md");
}

async function deployCommand() {
  console.log("Deploying launch daemons...\n");

  // Get UID
  const uidProc = Bun.spawn(["id", "-u"]);
  const uid = (await new Response(uidProc.stdout).text()).trim();

  const plists = [
    { file: "com.muavin.relay.plist", label: "com.muavin.relay" },
    { file: "com.muavin.cron.plist", label: "com.muavin.cron" },
  ];

  const homeDir = process.env.HOME!;
  const launchAgentsDir = `${homeDir}/Library/LaunchAgents`;
  const bunPath = Bun.which("bun")!;
  const repoRoot = resolve(import.meta.dir, "..");

  for (const { file, label } of plists) {
    const sourcePath = `${import.meta.dir}/../daemon/${file}`;
    const destPath = `${launchAgentsDir}/${file}`;

    // Read plist template and replace placeholders
    let plistContent = await Bun.file(sourcePath).text();
    plistContent = plistContent
      .replace(/__BUN_PATH__/g, bunPath)
      .replace(/__REPO_PATH__/g, repoRoot)
      .replace(/__HOME__/g, homeDir);

    await Bun.write(destPath, plistContent);
    console.log(`✓ Copied ${file}`);

    // Bootout (ignore errors)
    await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${label}`]).exited;

    // Bootstrap
    const bootstrapProc = Bun.spawn([
      "launchctl",
      "bootstrap",
      `gui/${uid}`,
      destPath,
    ]);
    await bootstrapProc.exited;

    if (bootstrapProc.exitCode === 0) {
      console.log(`✓ Loaded ${label}`);
    } else {
      console.log(`✗ Failed to load ${label}`);
    }
  }

  console.log("\nVerifying deployment...");
  const listProc = Bun.spawn(["launchctl", "list"], {
    stdout: "pipe",
  });
  const output = await new Response(listProc.stdout).text();
  const muavinServices = output
    .split("\n")
    .filter((line) => line.includes("muavin"));

  if (muavinServices.length > 0) {
    console.log("✓ Active services:");
    muavinServices.forEach((line) => console.log(`  ${line}`));
  } else {
    console.log("✗ No muavin services found");
  }
}

async function statusCommand() {
  console.log("Muavin Status\n");

  // Check daemons
  console.log("Daemons:");
  const listProc = Bun.spawn(["launchctl", "list"], { stdout: "pipe" });
  const output = await new Response(listProc.stdout).text();
  const muavinServices = output
    .split("\n")
    .filter((line) => line.includes("muavin"));

  if (muavinServices.length > 0) {
    muavinServices.forEach((line) => console.log(`  ${line}`));
  } else {
    console.log("  No muavin services running");
  }

  // Check sessions
  console.log("\nSessions:");
  const sessionsPath = `${process.env.HOME}/.muavin/sessions.json`;
  try {
    const sessionsFile = Bun.file(sessionsPath);
    if (await sessionsFile.exists()) {
      const sessions = await sessionsFile.json();
      for (const [chatId, session] of Object.entries(sessions) as [string, any][]) {
        const sessionId = session.sessionId ? session.sessionId.slice(0, 8) + "..." : "none";
        console.log(`  Chat ${chatId}: ${sessionId} (${session.updatedAt ?? "unknown"})`);
      }
    } else {
      console.log("  No sessions file");
    }
  } catch {
    console.log("  Error reading sessions");
  }

  // Check cron state
  console.log("\nCron:");
  const cronStatePath = `${process.env.HOME}/.muavin/cron-state.json`;
  try {
    const cronFile = Bun.file(cronStatePath);
    if (await cronFile.exists()) {
      const cronState = await cronFile.json();
      for (const [jobId, timestamp] of Object.entries(cronState)) {
        const date = typeof timestamp === "number" ? new Date(timestamp as number).toLocaleString() : "never";
        console.log(`  ${jobId}: ${date}`);
      }
    } else {
      console.log("  No cron state file");
    }
  } catch {
    console.log("  Error reading cron state");
  }
}

async function testCommand() {
  console.log("Running smoke tests...\n");

  // Test memory
  console.log("Testing memory...");
  try {
    const { logMessage, searchContext, supabase } = await import("./memory");
    await logMessage("user", "cli-test", "test");
    const results = await searchContext("cli-test");
    if (results.length > 0) {
      console.log("✓ Memory round-trip successful");
    } else {
      console.log("✗ Memory search returned no results");
    }
    await supabase.from("messages").delete().eq("chat_id", "test").eq("content", "cli-test");
  } catch (error) {
    console.log(`✗ Memory test failed: ${error}`);
  }

  // Test Telegram
  console.log("Testing Telegram...");
  try {
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
    const me = await bot.api.getMe();
    console.log(`✓ Telegram bot: @${me.username}`);
  } catch (error) {
    console.log(`✗ Telegram test failed: ${error}`);
  }

  // Test cron config
  console.log("Testing cron config...");
  try {
    const cronFile = Bun.file(`${process.env.HOME}/.muavin/config.json`);
    const config = await cronFile.json();
    if (
      Array.isArray(config.cron) &&
      config.cron.every((job: any) => job.id && job.intervalMinutes)
    ) {
      console.log(`✓ Cron config valid (${config.cron.length} jobs)`);
    } else {
      console.log("✗ Cron config invalid");
    }
  } catch (error) {
    console.log(`✗ Cron test failed: ${error}`);
  }
}

main();

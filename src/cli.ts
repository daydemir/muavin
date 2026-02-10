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
    default:
      heading("Muavin CLI\n");
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
  heading("🚀 Muavin Setup Wizard\n");

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
    await updateEnvFile(telegram);
    await updateMuavinConfig(telegram.userId);
  }

  // Step 3: Setup Supabase (or skip if already configured)
  let supabase = await checkExistingSupabase(existingEnv);
  if (!supabase) {
    supabase = await setupSupabase();
    if (!supabase) return;
    await updateEnvFile(telegram, supabase);
  }

  // Step 4: Verify all services
  if (!await verifyAll()) {
    return;
  }

  // Step 5: Finalize
  await copyCLAUDEmd();

  // Step 6: Offer deploy
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

async function updateEnvFile(
  telegram: { token: string; userId: string },
  supabase?: { url: string; key: string }
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
  };
  if (supabase) {
    updates.SUPABASE_URL = supabase.url;
    updates.SUPABASE_SERVICE_KEY = supabase.key;
  }

  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Z_]+)=/);
    if (match && match[1] in updates) {
      return `${match[1]}=${updates[match[1]]}`;
    }
    return line;
  });

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

async function deployCommand() {
  heading("Building and deploying...\n");

  const homeDir = process.env.HOME!;
  const repoRoot = resolve(import.meta.dir, "..");
  const distDir = `${repoRoot}/dist`;
  const muavinBinDir = `${homeDir}/.muavin/bin`;

  // Build compiled binaries
  heading("Building binaries...");
  await mkdir(distDir, { recursive: true });

  const binaries = [
    { src: "src/relay.ts", out: "muavin-relay", id: "com.muavin.relay" },
    { src: "src/cron.ts", out: "muavin-cron", id: "com.muavin.cron" },
    { src: "src/heartbeat.ts", out: "muavin-heartbeat", id: "com.muavin.heartbeat" },
  ];

  for (const bin of binaries) {
    const buildProc = Bun.spawn([
      "bun", "build", "--compile", `${repoRoot}/${bin.src}`, "--outfile", `${distDir}/${bin.out}`,
    ], { stdout: "pipe", stderr: "pipe" });
    await buildProc.exited;

    if (buildProc.exitCode !== 0) {
      const stderr = await new Response(buildProc.stderr).text();
      fail(`Build failed for ${bin.out}: ${stderr}`);
      return;
    }
    ok(`Built ${bin.out}`);

    const signProc = Bun.spawn([
      "codesign", "--force", "--sign", "-", "--identifier", bin.id, `${distDir}/${bin.out}`,
    ], { stdout: "pipe", stderr: "pipe" });
    await signProc.exited;

    if (signProc.exitCode !== 0) {
      const stderr = await new Response(signProc.stderr).text();
      fail(`Codesign failed for ${bin.out}: ${stderr}`);
      return;
    }
    ok(`Signed ${bin.out} (${bin.id})`);
  }

  // Copy to ~/.muavin/bin/
  console.log();
  heading("Installing binaries...");
  await mkdir(muavinBinDir, { recursive: true });

  for (const bin of binaries) {
    const cpProc = Bun.spawn(["cp", `${distDir}/${bin.out}`, `${muavinBinDir}/${bin.out}`]);
    await cpProc.exited;
    await Bun.spawn(["chmod", "+x", `${muavinBinDir}/${bin.out}`]).exited;
    ok(`Installed ${bin.out}`);
  }

  // Deploy launch daemons
  console.log();
  heading("Deploying launch daemons...");

  const uidProc = Bun.spawn(["id", "-u"]);
  const uid = (await new Response(uidProc.stdout).text()).trim();

  const plists = [
    { file: "com.muavin.relay.plist", label: "com.muavin.relay" },
    { file: "com.muavin.cron.plist", label: "com.muavin.cron" },
    { file: "com.muavin.heartbeat.plist", label: "com.muavin.heartbeat" },
  ];

  const launchAgentsDir = `${homeDir}/Library/LaunchAgents`;

  for (const { file, label } of plists) {
    const sourcePath = `${repoRoot}/daemon/${file}`;
    const destPath = `${launchAgentsDir}/${file}`;

    let plistContent = await Bun.file(sourcePath).text();
    plistContent = plistContent
      .replace(/__MUAVIN_BIN__/g, muavinBinDir)
      .replace(/__HOME__/g, homeDir);

    await Bun.write(destPath, plistContent);
    ok(`Copied ${file}`);

    await Bun.spawn(["launchctl", "bootout", `gui/${uid}/${label}`]).exited;

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
      config.cron.every((job: any) => job.id && job.intervalMinutes)
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

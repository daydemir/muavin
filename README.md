# Claw

Personal AI agent powered by OpenClaw.

## Architecture

Six agents with two security boundaries:

**Untrusted Intake** (no action tools, structured JSON only):

| Agent | Model | Role |
|-------|-------|------|
| **Reader** | Opus 4.6 (cloud) | Email/messages → structured JSON |
| **Researcher** | Gemini 2.5 Pro (cloud) | Web/papers → structured JSON |
| **Social** | Grok 3 (cloud) | Social/tweets → structured JSON |

**Orchestrator** (no execution tools):

| Agent | Model | Role |
|-------|-------|------|
| **Conductor** | Opus 4.6 (cloud) | Routes, decides, spawns agents. No runtime access. |

**Trusted Execution** (action tools, local Ollama):

| Agent | Model | Role |
|-------|-------|------|
| **Tortoise** | Qwen3 32B Q4 (local) | Apple integrations, files, heavy reasoning, heartbeats |

**Trusted Execution** (cloud, code only):

| Agent | Model | Role |
|-------|-------|------|
| **Coder** | GPT 5.3 Codex (cloud) | Bash, filesystem, ralph loops |

**Future:**

| Agent | Model | Role |
|-------|-------|------|
| **Sender** | TBD | Outbound comms (email, social). See [docs/SENDER_FUTURE.md](docs/SENDER_FUTURE.md). |

**Est. cost:** ~$150-200/mo (Opus ~$100-150 + Codex $20 + Gemini ~$10-20 + Grok ~$5-10 + local free)

## MacBook Pro Setup (M1 Max 64GB, headless 24/7)

### 1. Physical setup

- Ethernet adapter connected
- HDMI dummy plug inserted
- Place in closet/shelf, keep ventilated

### 2. macOS configuration

```bash
# Prevent sleep (plugged in)
sudo pmset -c sleep 0 -c disksleep 0 -c displaysleep 10

# Enable SSH
sudo systemsetup -setremotelogin on

# Verify
pmset -g
```

### 3. Install dependencies

```bash
# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Tailscale (remote access)
brew install tailscale
# Open Tailscale app and sign in

# Node.js
brew install node@22

# Ollama (local models)
brew install ollama

# OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Apple CLI tools (for Tortoise agent)
brew install steipete/tap/remindctl
brew tap antoniorodr/memo && brew install antoniorodr/memo/memo
```

Grant macOS permissions:
- System Settings → Privacy & Security → Reminders → Enable Terminal
- System Settings → Privacy & Security → Full Disk Access → Enable Terminal

### 4. Pull local models

```bash
# Start Ollama service
brew services start ollama

# Pull Qwen3 32B Q4 (20GB download, heavy reasoning — Tortoise)
ollama pull qwen3:32b

# Verify
ollama list
curl http://localhost:11434/api/tags
```

### 5. Network-isolate Ollama

Block Ollama from making any outbound internet connections. It only needs localhost to serve models.

```bash
# Install Lulu (free open-source macOS firewall)
brew install --cask lulu

# When Ollama makes its first outbound connection attempt, Lulu will prompt — deny it.
# Verify Ollama still works locally:
curl http://localhost:11434/api/tags
```

See [docs/PROMPT_INJECTION_DEFENSE.md](docs/PROMPT_INJECTION_DEFENSE.md) (Layer 0) for details.

### 6. Set up .env

Clone this repo, then copy the `.env` file from your dev machine:

```bash
git clone <this-repo> ~/claw
# Copy .env from dev machine (AirDrop, scp, or manually create)
# scp devmachine:~/path/to/claw/.env ~/claw/.env
```

Or create `~/.openclaw/.env` manually with:

```
ANTHROPIC_API_KEY=<your key>
OPENAI_API_KEY=<your key>
GEMINI_API_KEY=<your key>
OPENROUTER_API_KEY=<your key>
XAI_API_KEY=<your key>
BRAVE_API_KEY=<your key>
GATEWAY_TOKEN=<your key>
```

### 7. Deploy OpenClaw config

```bash
# Create OpenClaw directory
mkdir -p ~/.openclaw
chmod 700 ~/.openclaw

# Copy config
cp ~/claw/configs/openclaw.json ~/.openclaw/openclaw.json

# Copy env (if not already there)
cp ~/claw/.env ~/.openclaw/.env
chmod 600 ~/.openclaw/.env
```

### 8. Onboard and start

```bash
# Run onboard wizard (sets up auth, gateway, channels)
openclaw onboard --install-daemon

# Set gateway to local mode
openclaw config set gateway.mode local

# Security audit
openclaw security audit --deep --fix
```

### 9. Verify

```bash
# Ollama running with model loaded
ollama list

# OpenClaw gateway running
openclaw gateway status

# Tailscale connected
tailscale status

# Dashboard (optional, for debugging)
openclaw dashboard
```

### 10. Install Codex CLI (Coder agent)

Requires ChatGPT Plus subscription ($20/mo).

```bash
npm install -g @openai/codex
```

Set `CODEX_API_KEY` in your environment or authenticate via the CLI.

## Hetzner VPS Deployment (legacy)

See `scripts/deploy.sh` and `terraform/` for cloud VPS deployment. This is the older setup for the cax11 ARM server.

```bash
# Deploy a new instance
./scripts/deploy.sh <name>

# Sync config to running instance
./scripts/sync-config.sh <name>
```

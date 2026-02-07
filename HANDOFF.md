# Deployment Handoff — muavin-deniz-1

## Current State

Fresh deploy on Hetzner Cloud in Nuremberg (nbg1):
- **Type:** cax11 (ARM, 2 vCPU, 4GB RAM, 40GB disk) — ~$4.30/mo
- **Tailscale hostname:** `muavin-deniz-1`

### What cloud-init sets up automatically
- Ubuntu 24.04 with `openclaw` user (sudo, SSH key)
- SSH hardened (root login disabled, password auth disabled)
- Tailscale VPN connected to your tailnet
- Node.js 22
- OpenClaw CLI installed globally
- UFW firewall (SSH + Tailscale UDP only)
- fail2ban
- API keys in `/home/openclaw/.openclaw/.env`
- OpenClaw config in `/home/openclaw/.openclaw/openclaw.json`
- systemd linger enabled for openclaw user

### What you need to do manually

SSH in after cloud-init finishes (~3 min):

```bash
ssh openclaw@muavin-deniz-1
```

Then:

```bash
openclaw onboard
```

After that:
1. Connect your Telegram bot to the instance
2. Configure personality/skills as desired

### Updating config later

Edit `configs/openclaw.json` locally, then:
```bash
./scripts/sync-config.sh muavin-deniz-1
```

### Redeploying from scratch

```bash
./scripts/deploy.sh muavin-deniz-1
# Wait ~3 min for cloud-init, then SSH in and run openclaw onboard
```

### Stale Tailscale nodes

If you redeploy, delete the old Tailscale node from https://login.tailscale.com/admin/machines before the new server joins, otherwise it will get a suffixed hostname.

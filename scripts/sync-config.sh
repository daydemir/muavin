#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: ./scripts/sync-config.sh <name>"
  echo "Example: ./scripts/sync-config.sh deniz"
  exit 1
fi

NAME="$1"

# Get Tailscale IP for the instance
TS_IP=$(tailscale status --json | jq -r ".Peer[] | select(.HostName==\"${NAME}\") | .TailscaleIPs[0]")

if [ -z "$TS_IP" ] || [ "$TS_IP" = "null" ]; then
  echo "Error: Could not find Tailscale IP for ${NAME}"
  echo "Is the server online? Check: tailscale status"
  exit 1
fi

echo "Syncing config to ${NAME} (${TS_IP})..."
scp configs/openclaw.json "openclaw@${TS_IP}:~/.openclaw/openclaw.json"
ssh "openclaw@${TS_IP}" "chmod 600 ~/.openclaw/openclaw.json && openclaw gateway restart"
echo "Done. Config synced and gateway restarted."

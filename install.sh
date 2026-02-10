#!/usr/bin/env bash
set -euo pipefail

# Muavin installer
# Usage: curl -fsSL https://raw.githubusercontent.com/thisisdeniz/muavin/main/install.sh | bash

REPO="https://github.com/thisisdeniz/muavin.git"
INSTALL_DIR="$HOME/.muavin/src"

echo ""
echo "  Installing Muavin..."
echo ""

# Check macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Error: Muavin requires macOS."
  exit 1
fi

# Check/install Bun
if ! command -v bun &>/dev/null; then
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
echo "  ✓ Bun $(bun --version)"

# Check/install Claude Code CLI
if ! command -v claude &>/dev/null; then
  echo "Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code
fi
echo "  ✓ Claude CLI found"

# Clone repo
if [[ -d "$INSTALL_DIR" ]]; then
  echo "  ✓ Muavin already cloned at $INSTALL_DIR"
  cd "$INSTALL_DIR" && git pull --quiet
else
  echo "Cloning Muavin..."
  git clone --quiet "$REPO" "$INSTALL_DIR"
fi

# Install dependencies
cd "$INSTALL_DIR"
bun install --silent

# Add shell alias
ALIAS_LINE='alias muavin="bun run --cwd $HOME/.muavin/src src/cli.ts"'
for rcfile in "$HOME/.zshrc" "$HOME/.bashrc"; do
  if [[ -f "$rcfile" ]] && ! grep -q "alias muavin=" "$rcfile"; then
    echo "" >> "$rcfile"
    echo "$ALIAS_LINE" >> "$rcfile"
    echo "  ✓ Added muavin alias to $(basename "$rcfile")"
  fi
done

echo ""
echo "  ✓ Muavin installed!"
echo ""
echo "  Next steps:"
echo "    1. Restart your shell (or run: source ~/.zshrc)"
echo "    2. Run: muavin setup"
echo ""

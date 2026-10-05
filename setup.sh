#!/usr/bin/env bash
# Installs Tandem and its tools. Safe to re-run: anything already installed is skipped.
set -euo pipefail
cd "$(dirname "$0")"

[[ "$(uname)" == Darwin ]] || { echo "Tandem needs macOS." >&2; exit 1; }
command -v git >/dev/null || { echo "git is missing; run: xcode-select --install" >&2; exit 1; }

export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

have=""
need() { # need <command> <install command>
  if command -v "$1" >/dev/null; then
    have="$have $1"
  else
    echo "→ installing $1"
    bash -c "$2"
  fi
}

quiet() { # quiet <command...>: prints its output only if it fails
  local out
  out="$("$@" 2>&1)" || { echo "$out" >&2; return 1; }
}

need bun       'curl -fsSL https://bun.com/install | bash'
need herdr     'curl -fsSL https://herdr.dev/install.sh | sh'
need treehouse 'curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh'
need omp       'bun install -g @oh-my-pi/pi-coding-agent'
need lavish-axi 'bun install -g lavish-axi'

if command -v gh >/dev/null || command -v brew >/dev/null; then
  need gh 'brew install gh'
  gh auth status >/dev/null 2>&1 || echo "! Sign in to GitHub so Tandem can open pull requests: gh auth login"
else
  echo "! Install the GitHub CLI for pull requests: https://cli.github.com/"
fi
[[ -z "$have" ]] || echo "✓$have"

quiet bun install
quiet bun link
echo "✓ tandem"

# Herdr >= 0.8.2 for the status popup, tab bar, and notifications; asks before editing its config.
bun src/terminal-backend/herdr/setup.ts

if ! grep -qs '.bun/bin' "$HOME/.zshrc"; then
  echo
  echo "Add this to ~/.zshrc so 'tandem' works in new terminals:"
  echo '  export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"'
fi

echo "Done. Run 'tandem' from any folder."

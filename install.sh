#!/usr/bin/env bash
# Build claudeswitch and install it into ~/.local/bin.
set -euo pipefail

BIN_DIR="${CLAUDESWITCH_BIN_DIR:-$HOME/.local/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$BIN_DIR/claudeswitch"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }

if [ "${1:-}" = "--uninstall" ]; then
  # The scheduled refresh has to go first: left behind, it would keep firing
  # every week against a binary that no longer exists.
  AGENT="$HOME/Library/LaunchAgents/com.claudeswitch.keepwarm.plist"
  if [ -f "$AGENT" ]; then
    if [ -x "$TARGET" ]; then
      "$TARGET" keepwarm --uninstall >/dev/null 2>&1 || true
    fi
    if [ -f "$AGENT" ]; then
      launchctl bootout "gui/$(id -u)/com.claudeswitch.keepwarm" 2>/dev/null || true
      launchctl unload -w "$AGENT" 2>/dev/null || true
      rm -f "$AGENT"
    fi
    ok "Removed the keep-warm agent"
  fi

  rm -f "$TARGET" && ok "Removed $TARGET"
  dim "Now delete the '# >>> claudeswitch >>>' block from your shell rc file."
  dim "Your accounts stay in ~/.claudeswitch — remove that directory to erase them."
  dim "Credentials live in the macOS Keychain; sign each account out first to clear them."
  exit 0
fi

command -v bun >/dev/null || {
  echo "bun is required to build. Install it with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

command -v claude >/dev/null || warn "The 'claude' CLI is not on PATH — install Claude Code before using claudeswitch."

bold "Building…"
cd "$HERE"
bun install --silent
bun run build

mkdir -p "$BIN_DIR"
# Copied, not symlinked: the shell hook embeds this path, so it must stay valid
# even if this source directory is moved or deleted.
#
# Installed through a temporary file and a rename, never written in place.
# Overwriting a Mach-O binary's bytes keeps the same inode, and macOS then kills
# it on launch because the signature it cached for that file no longer matches
# ("Killed: 9", exit 137). A rename gives a fresh inode and sidesteps that.
cp -f "$HERE/dist/claudeswitch" "$TARGET.new"
chmod +x "$TARGET.new"
mv -f "$TARGET.new" "$TARGET"
ok "Installed $TARGET"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add it to your shell rc file first." ;;
esac

echo
bold "Next steps"
echo "  1. Install the shell integration:   $TARGET init --install"
echo "  2. Reload your shell:               source ~/.zshrc"
echo "  3. Adopt your current account:      cs import"
echo "  4. Add another account:             cs add work"
echo "  5. Switch this terminal only:       cs use work"
echo
dim "Uninstall with: $HERE/install.sh --uninstall"

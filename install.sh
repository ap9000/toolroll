#!/bin/sh
# Toolroll, in one command (macOS and Linux):
#
#   curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh | sh
#
# It checks what it needs (Node.js 22.13 or newer, git), installs the
# `toolroll` command with npm (`standing-orders`, the older name, still
# works), and starts it with your projects in ~/Projects. Nothing runs as root, and nothing is installed but the one npm
# package. Settings:
#   SO_PROJECTS=/path/to/projects   where your repositories live (default ~/Projects)
#   SO_VERSION=0.5.0                a particular release (default: the latest)
#   SO_NO_START=1                   install only; start later with `toolroll up`
set -eu

say() { printf '%s\n' "$*"; }
stop() { printf '\nToolroll: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) stop "this installer is for macOS and Linux. On Windows, use WSL, or run: npx toolroll up" ;;
esac

if ! command -v node >/dev/null 2>&1; then
  stop "it needs Node.js 22.13 or newer, and none was found. Install it (https://nodejs.org, \`brew install node\`, or \`fnm install 22\`), then run this again."
fi
version=$(node -p 'process.versions.node')
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
  stop "it needs Node.js 22.13 or newer; this computer has $version. Update Node, then run this again."
fi
command -v git >/dev/null 2>&1 || stop "it needs git. Install it, then run this again."
command -v npm >/dev/null 2>&1 || stop "it needs npm, which comes with Node.js."

agents=""
for one in claude codex; do
  if command -v "$one" >/dev/null 2>&1; then agents="$agents $one"; fi
done

package="${SO_PACKAGE:-toolroll@${SO_VERSION:-latest}}"
say "Installing $package …"
# The toolroll package also provides the `standing-orders` command, which npm
# won't link over the older standing-orders package's copy without --force.
# The old package's files stay, so a service installed from them keeps running.
force=""
if npm ls -g standing-orders --depth=0 >/dev/null 2>&1; then force="--force"; fi
if ! npm install -g "$package" $force --no-fund --no-audit --loglevel=error; then
  stop "npm couldn't install it. If it said permission denied, give npm a folder you own: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
fi
# Releases before the rename only have the older `standing-orders` name.
cli="toolroll"
command -v toolroll >/dev/null 2>&1 || cli="standing-orders"
say "Installed $("$cli" --version 2>/dev/null || echo "$cli")."

if [ -z "$agents" ]; then
  say ""
  say "No coding agent was found (Claude Code or Codex). The app works without one;"
  say "install one when you want work built: npm install -g @anthropic-ai/claude-code"
  say "(or npm install -g @openai/codex), then sign in with claude auth login (or codex login)."
fi
if [ "$(uname -s)" = "Linux" ] && ! command -v bwrap >/dev/null 2>&1; then
  say ""
  say "Tip: install bubblewrap (apt install bubblewrap) so Claude and Gemini agents can't read"
  say "Toolroll's own secrets on this computer. Codex is fenced without it."
fi

if [ "${SO_NO_START:-}" = "1" ]; then
  say ""
  say "Start it with: $cli up --project-root \"${SO_PROJECTS:-$HOME/Projects}\""
  exit 0
fi

projects="${SO_PROJECTS:-$HOME/Projects}"
mkdir -p "$projects"
say ""
say "Starting Toolroll with your projects in $projects …"
exec "$cli" up --project-root "$projects"

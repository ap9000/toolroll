#!/bin/sh
# Toolroll, in one command (macOS and Linux):
#
#   curl -fsSL https://raw.githubusercontent.com/ap9000/toolroll/main/install.sh | sh
#
# It checks what it needs (Node.js 22.13 or newer, git 2.41 or newer), installs
# the `toolroll` command with npm (`standing-orders`, the older name, still
# works), and opens it in this terminal: on the repository you run it in, or,
# outside one, with your projects in ~/Projects. Nothing runs as root, and
# nothing is installed but the one npm package. Settings:
#   SO_PROJECTS=/path/to/projects   where your repositories live (default: this repository, else ~/Projects)
#   SO_VERSION=0.5.0                a particular release (default: the latest)
#   SO_NO_START=1                   install only; it prints the command that starts it
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
command -v git >/dev/null 2>&1 || stop "it needs git 2.41 or newer. Install it, then run this again."
# "git version 2.39.5 (Apple Git-154)" -> 2 39. A version it can't read is not refused here.
gitv=$(git --version 2>/dev/null | sed -n 's/^git version \([0-9][0-9]*\)\.\([0-9][0-9]*\).*/\1 \2/p')
if [ -n "$gitv" ]; then
  gmajor=${gitv% *}
  gminor=${gitv#* }
  if [ "$gmajor" -lt 2 ] || { [ "$gmajor" -eq 2 ] && [ "$gminor" -lt 41 ]; }; then
    stop "it needs git 2.41 or newer; this computer has $gmajor.$gminor. Update git (https://git-scm.com/downloads, or \`brew install git\`), then run this again."
  fi
fi
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
  say "No coding agent was found (Claude Code or Codex). Toolroll needs one to build your tasks:"
  say "npm install -g @anthropic-ai/claude-code (or npm install -g @openai/codex),"
  say "then sign in with claude auth login (or codex login)."
fi
if [ "$(uname -s)" = "Linux" ] && ! command -v bwrap >/dev/null 2>&1; then
  say ""
  say "Tip: install bubblewrap (apt install bubblewrap) so Claude agents can't read"
  say "Toolroll's own secrets on this computer. Codex is fenced without it."
fi

projects="${SO_PROJECTS:-$HOME/Projects}"
# The start command, with the folder single-quoted for a shell (a ' inside it becomes '\'').
q() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }

# Run inside a git repository (and no SO_PROJECTS chosen): Toolroll starts on that repository, here.
here=""
if [ -z "${SO_PROJECTS:-}" ]; then here=$(git rev-parse --show-toplevel 2>/dev/null || true); fi

if [ "${SO_NO_START:-}" = "1" ]; then
  say ""
  if [ -n "$here" ]; then say "Start it in $here with: $cli"; else say "Start it with: $cli --project-root $(q "$projects")"; fi
  exit 0
fi

if [ -n "$here" ]; then
  if ( : </dev/tty >/dev/tty ) 2>/dev/null; then
    say ""
    say "Starting Toolroll in $here …"
    cd "$here"
    exec "$cli" </dev/tty >/dev/tty 2>&1
  fi
  say ""
  say "Start it in $here with: $cli"
  exit 0
fi

mkdir -p "$projects"
# Piped into sh, this script's input is the download, not you: Toolroll opens on the terminal itself. With no terminal
# (a script, CI), it says how to start instead.
if ( : </dev/tty >/dev/tty ) 2>/dev/null; then
  say ""
  say "Starting Toolroll with your projects in $projects …"
  exec "$cli" --project-root "$projects" </dev/tty >/dev/tty 2>&1
fi
say ""
say "Start it with: $cli --project-root $(q "$projects")"

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

# How to get a new enough Node, said the same way whether none was found or it is too old. On Linux, the
# distribution's own nodejs package is usually older than 22 (Ubuntu 24.04's is 18), so it points at nvm or NodeSource.
if [ "$(uname -s)" = "Linux" ]; then
  node_how="Install it from https://nodejs.org/en/download (choose nvm: \`nvm install 22\`), or from NodeSource (https://github.com/nodesource/distributions); \`apt install nodejs\` is usually too old"
else
  node_how="Install it from https://nodejs.org/en/download, or with \`brew install node\`"
fi
if ! command -v node >/dev/null 2>&1; then
  stop "it needs Node.js 22.13 or newer, and none was found. $node_how. Then run this again."
fi
version=$(node -p 'process.versions.node')
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 13 ]; }; then
  stop "it needs Node.js 22.13 or newer; this computer has $version. $node_how. Then run this again."
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
# On Linux, agents run in a sandbox that needs these programs, each <command>:<package> (the same list as
# LINUX_SANDBOX_TOOLS in src/sandbox-runtime.ts; src/sandbox-runtime.test.ts keeps the two the same). Toolroll starts
# only once they are all there.
sandbox_missing=""
if [ "$(uname -s)" = "Linux" ]; then
  for tool in bwrap:bubblewrap socat:socat rg:ripgrep; do
    command -v "${tool%%:*}" >/dev/null 2>&1 || sandbox_missing="$sandbox_missing ${tool#*:}"
  done
fi
if [ -n "$sandbox_missing" ]; then
  say ""
  say "Toolroll runs agents in a sandbox, which on this computer needs:$sandbox_missing. Install them:"
  say "sudo apt install$sandbox_missing (Fedora: sudo dnf install$sandbox_missing)"
fi

projects="${SO_PROJECTS:-$HOME/Projects}"
# The start command, with the folder single-quoted for a shell (a ' inside it becomes '\'').
q() { printf "'%s'" "$(printf %s "$1" | sed "s/'/'\\\\''/g")"; }

# Run inside a git repository (and no SO_PROJECTS chosen): Toolroll starts on that repository, here. Nothing in the
# environment or the repository's config may point it somewhere else: every git override is cleared (for git and for
# the Toolroll started below), no system or global config is read, and git's answer is kept only when it is a real
# folder holding a .git folder that contains the folder this was run in. Anything else: ~/Projects, as before. (A
# linked `git worktree` checkout, whose .git is a file, also falls back.)
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM GIT_NAMESPACE GIT_PREFIX GIT_CONFIG GIT_CONFIG_PARAMETERS \
  GIT_CONFIG_COUNT GIT_CONFIG_SYSTEM GIT_CONFIG_GLOBAL GIT_EXEC_PATH GIT_TEMPLATE_DIR 2>/dev/null || true
# The repository is identified apart from core.worktree too: its git folder must be exactly <top>/.git, and no
# core.worktree may be set (a nested repository pointing its worktree at an enclosing one is refused).
g() { GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.fsmonitor=false "$@"; }
repo_here() {
  cwd=$(pwd -P 2>/dev/null) || return 0
  top=$(g rev-parse --show-toplevel 2>/dev/null) || return 0
  [ -n "$top" ] || return 0
  top=$(cd "$top" 2>/dev/null && pwd -P) || return 0
  [ -d "$top/.git" ] || return 0
  gitdir=$(g rev-parse --absolute-git-dir 2>/dev/null) || return 0
  gitdir=$(cd "$gitdir" 2>/dev/null && pwd -P) || return 0
  [ "$gitdir" = "$top/.git" ] || return 0
  [ -z "$(g config --get core.worktree 2>/dev/null)" ] || return 0
  case "$cwd/" in
    "$top"/*) printf '%s' "$top" ;;
  esac
}
here=""
if [ -z "${SO_PROJECTS:-}" ]; then here=$(repo_here); fi

if [ "${SO_NO_START:-}" = "1" ] || [ -n "$sandbox_missing" ]; then
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

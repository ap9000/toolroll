public enum CanvasCaptureScript {
    public static let name = "canvas-capture-ios.sh"
    public static let source = #"""
#!/bin/bash
# Photograph the iPhone companion's screens for the Toolroll Canvas ("App · iPhone").
#
# Reads the "ios" surface of .youi/screens/app.json (toolroll.app-screens/v1), builds the app for the Simulator
# (Debug, unsigned: the screens use the app's DEBUG-only --screen / --debug-state launch routes and its --demo
# workspace, never a real pairing), then for each appearance and screen launches it in its OWN Simulator, named
# "Toolroll Canvas" (made once, reused after; no other Simulator is ever touched), waits, and saves a screenshot.
#
# Writes <screen>-<appearance>.png and index.json (toolroll.app-captures/v1) to
#   <cache-dir>/<state-key>/              (default cache-dir: ~/.cache/toolroll/canvas/<repo hash>/app/ios)
# and mirrors the same set to <repo>/.youi/screens/toolroll/ios/ (ignored by git) for other readers.
#
# The state key is the one the Mac Canvas computes (AppSurfaceStorage.surfaceStateKey): a content key over the
# surface's own files, so a capture taken here shows as fresh on the Canvas.
#
# Usage: scripts/canvas-capture-ios.sh [--repo DIR] [--surface ios] [--state-key KEY] [--cache-dir DIR]
#                                      [--wait SECONDS] [--keep-booted] [--print-state-key]
# Lines starting "progress:" and "error:" are read by the Mac Canvas; everything else is log. The Mac app runs the
# copy built into it (mac/scripts/embed-canvas-capture.sh), never a script a project names.

set -euo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
export LC_ALL=C

say() { printf 'progress: %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*"; exit 1; }

repo=""
surface="ios"
state_key=""
cache_dir=""
wait_seconds="3.5"
keep_booted=0
print_key=0
device_name="Toolroll Canvas"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?}"; shift 2 ;;
    --surface) surface="${2:?}"; shift 2 ;;
    --state-key) state_key="${2:?}"; shift 2 ;;
    --cache-dir) cache_dir="${2:?}"; shift 2 ;;
    --wait) wait_seconds="${2:?}"; shift 2 ;;
    --keep-booted) keep_booted=1; shift ;;
    --print-state-key) print_key=1; shift ;;
    -h|--help) [ -f "$0" ] && sed -n '2,22p' "$0"; exit 0 ;;
    *) fail "unknown option $1" ;;
  esac
done

if [ -z "$repo" ]; then
  # Run from a checkout, the default is that checkout; the Mac app runs its own copy and always names --repo.
  [ -f "$0" ] || fail "--repo is required"
  repo="$(cd "$(dirname "$0")/.." && pwd -P)"
fi
cd "$repo" || fail "can't open $repo"
repo="$(pwd -P)"

case "$surface" in
  ''|*[!a-z0-9-]*) fail "the surface id must be a short slug" ;;
esac
case "$wait_seconds" in
  ''|*[!0-9.]*) fail "--wait takes seconds" ;;
esac

# ---------------------------------------------------------------- git, as the Mac reads it (HardenedGit)
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
git_() {
  /usr/bin/git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false -c protocol.ext.allow=never "$@"
}
git_refuses() {
  local entry key value
  while IFS= read -r -d '' entry; do
    key="$(printf '%s' "${entry%%$'\n'*}" | tr '[:upper:]' '[:lower:]')"
    value=""
    case "$entry" in *$'\n'*) value="$(printf '%s' "${entry#*$'\n'}" | tr '[:upper:]' '[:lower:]' | tr -d ' \t')" ;; esac
    case "$key" in
      core.fsmonitor) case "$value" in ''|false|no|off|0) ;; *) return 0 ;; esac ;;
      filter.*) return 0 ;;
    esac
  done < <(git_ config --list --includes -z 2>/dev/null || true)  # guard: allow no git config is fine; defaults apply
  return 1
}

# ---------------------------------------------------------------- the manifest
manifest="$repo/.youi/screens/app.json"
[ -f "$manifest" ] && [ ! -L "$manifest" ] || fail ".youi/screens/app.json isn't in $repo"
extract() { plutil -extract "$1" raw -o - "$manifest" 2>/dev/null; }

surface_index=""
count="$(extract surfaces || echo 0)"
for ((i = 0; i < count; i++)); do
  if [ "$(extract "surfaces.$i.id")" = "$surface" ]; then surface_index="$i"; break; fi
done
[ -n "$surface_index" ] || fail "app.json declares no surface \"$surface\""
S="surfaces.$surface_index"
[ "$(extract "$S.kind")" = "ios" ] || fail "surface \"$surface\" isn't an iOS surface"

plain_path() {
  case "$1" in ''|/*|~*|*..*|*//*) return 1 ;; esac
  return 0
}
xcode_project="$(extract "$S.build.project")"
scheme="$(extract "$S.build.scheme")"
bundle_id="$(extract "$S.build.bundleId")"
device_type="$(extract "$S.device")"
plain_path "$xcode_project" || fail "build.project must be a path inside the project"
[ -d "$xcode_project" ] || fail "$xcode_project isn't there"

paths=()
for ((i = 0; i < $(extract "$S.paths" || echo 0); i++)); do
  p="$(extract "$S.paths.$i")"
  plain_path "$p" || fail "paths must be paths inside the project"
  paths+=("$p")
done
[ "${#paths[@]}" -gt 0 ] || fail "the surface lists no paths"

surface_appearances=()
for ((i = 0; i < $(extract "$S.appearances" || echo 0); i++)); do surface_appearances+=("$(extract "$S.appearances.$i")"); done

screen_count="$(extract "$S.screens" || echo 0)"
[ "$screen_count" -gt 0 ] || fail "the surface lists no screens"

# ---------------------------------------------------------------- the state key (same as the Mac's)
compute_state_key() {
  if git_refuses; then echo "unread"; return; fi
  git_ ls-files -s -z -- "${paths[@]}" >/dev/null 2>&1 || { echo "nogit"; return; }
  local digest
  digest="$(
    {
      git_ ls-files -s -z -- "${paths[@]}"
      printf '\n--\n'
      git_ ls-files -z -m -o --exclude-standard -- "${paths[@]}" | sort -z -u | while IFS= read -r -d '' f; do
        if [ -f "$f" ] && [ ! -L "$f" ]; then h="$(git_ hash-object --no-filters -- "$f")"; else h="missing"; fi
        printf '%s\0%s\n' "$f" "$h"
      done
    } | shasum -a 256 | cut -c1-12
  )"
  echo "s-$digest"
}
[ -n "$state_key" ] || state_key="$(compute_state_key)"
if [ "$print_key" = 1 ]; then echo "$state_key"; exit 0; fi
case "$state_key" in
  ''|*[!A-Za-z0-9._-]*) fail "the state key must be a plain name" ;;
esac
commit="$(git_ rev-parse --short=10 HEAD 2>/dev/null || echo nogit)"

if [ -z "$cache_dir" ]; then
  repo_hash="$(printf '%s' "$repo" | shasum -a 256 | cut -c1-12)"
  cache_dir="$HOME/.cache/toolroll/canvas/$repo_hash/app/$surface"
fi
mkdir -p "$cache_dir"
log="$cache_dir/capture.log"
: > "$log"

# One capture at a time on this Mac: they share the one Simulator.
lock="$HOME/.cache/toolroll/canvas/.capture-ios.lock"
mkdir -p "$(dirname "$lock")"
mkdir "$lock" 2>/dev/null || fail "another capture is running (remove $lock if none is)"
booted_here=0
udid=""
cleanup() {
  if [ "$booted_here" = 1 ] && [ "$keep_booted" = 0 ] && [ -n "$udid" ]; then
    xcrun simctl shutdown "$udid" >>"$log" 2>&1 || true  # guard: allow best-effort shutdown of the simulator this script booted
  fi
  rm -rf "$cache_dir/.incoming-$$"
  rmdir "$lock" 2>/dev/null || true  # guard: allow lock dir may already be gone
}
trap cleanup EXIT

# ---------------------------------------------------------------- our own Simulator
find_device() {
  xcrun simctl list devices available | sed -nE "s/^ +${device_name} \(([0-9A-F-]{36})\) \((Booted|Shutdown|Shutting Down|Booting)\) *$/\1/p" | head -1
}
say "Preparing the \"$device_name\" Simulator…"
udid="$(find_device)"
if [ -z "$udid" ]; then
  udid="$(xcrun simctl create "$device_name" "$device_type" 2>>"$log")" || fail "couldn't make the \"$device_name\" Simulator ($device_type); see $log"
fi
state="$(xcrun simctl list devices | sed -nE "s/^ +${device_name} \(${udid}\) \(([A-Za-z ]+)\).*/\1/p" | head -1)"
if [ "$state" != "Booted" ]; then
  xcrun simctl boot "$udid" >>"$log" 2>&1 || true  # guard: allow already-booted simulator is fine
  booted_here=1
fi
xcrun simctl bootstatus "$udid" -b >>"$log" 2>&1 || fail "the \"$device_name\" Simulator didn't boot; see $log"
os_version="iOS $(xcrun simctl getenv "$udid" SIMULATOR_RUNTIME_VERSION 2>/dev/null || echo '?')"
xcrun simctl status_bar "$udid" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 >>"$log" 2>&1 || true  # guard: allow status bar override is cosmetic

# ---------------------------------------------------------------- build and install
say "Building the app with Xcode…"
derived="$cache_dir/dd"
if ! xcodebuild build -quiet \
    -project "$xcode_project" -scheme "$scheme" -configuration Debug \
    -destination "platform=iOS Simulator,id=$udid" \
    -derivedDataPath "$derived" \
    CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= >>"$log" 2>&1; then
  reason="$(grep -m1 -E 'error:' "$log" | sed -E 's/^.*error: //' | cut -c1-200 || true)"  # guard: allow no error line to quote is fine
  fail "the Xcode build failed${reason:+: $reason} (log: $log)"
fi
app="$(ls -d "$derived"/Build/Products/Debug-iphonesimulator/*.app 2>/dev/null | head -1)"
[ -n "$app" ] || fail "the build made no app (log: $log)"
say "Installing on the Simulator…"
xcrun simctl install "$udid" "$app" >>"$log" 2>&1 || fail "couldn't install the app (log: $log)"

# ---------------------------------------------------------------- photograph each screen
incoming="$cache_dir/.incoming-$$"
rm -rf "$incoming"
mkdir -p "$incoming"
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

entries=()
failures=()
total=0
for ((i = 0; i < screen_count; i++)); do
  n="$(extract "$S.screens.$i.appearances" || echo "")"
  total=$((total + ${n:-${#surface_appearances[@]}}))
done
done_count=0

appearances_of() {
  local i="$1" n
  n="$(extract "$S.screens.$i.appearances" || true)"  # guard: allow screen without appearances falls back to light
  if [ -n "$n" ]; then
    for ((k = 0; k < n; k++)); do extract "$S.screens.$i.appearances.$k"; done
  else
    printf '%s\n' "${surface_appearances[@]}"
  fi
}

for appearance in light dark; do
  xcrun simctl ui "$udid" appearance "$appearance" >>"$log" 2>&1 || fail "couldn't set the $appearance appearance"
  for ((i = 0; i < screen_count; i++)); do
    wanted="$(appearances_of "$i")"
    case $'\n'"$wanted"$'\n' in *$'\n'"$appearance"$'\n'*) ;; *) continue ;; esac
    id="$(extract "$S.screens.$i.id")"
    case "$id" in ''|*[!a-z0-9-]*) failures+=("screen $i: its id isn't a slug"); continue ;; esac
    args=()
    for ((k = 0; k < $(extract "$S.screens.$i.launch" || echo 0); k++)); do args+=("$(extract "$S.screens.$i.launch.$k")"); done
    done_count=$((done_count + 1))
    say "Capturing $done_count/$total: $id ($appearance)"
    xcrun simctl terminate "$udid" "$bundle_id" >>"$log" 2>&1 || true  # guard: allow app may not be running yet
    if ! xcrun simctl launch "$udid" "$bundle_id" ${args[@]+"${args[@]}"} >>"$log" 2>&1; then
      failures+=("$id ($appearance): it didn't launch")
      continue
    fi
    sleep "$wait_seconds"
    file="$id-$appearance.png"
    if ! xcrun simctl io "$udid" screenshot --type=png "$incoming/$file" >>"$log" 2>&1; then
      failures+=("$id ($appearance): no screenshot")
      continue
    fi
    entries+=("{\"screen\": \"$id\", \"appearance\": \"$appearance\", \"file\": \"$file\", \"commit\": \"$commit\", \"captured_at\": \"$(now_iso)\"}")
  done
done
xcrun simctl terminate "$udid" "$bundle_id" >>"$log" 2>&1 || true  # guard: allow app may not be running

[ "${#entries[@]}" -gt 0 ] || fail "no screen was captured: ${failures[*]:-unknown} (log: $log)"

captured_at="$(now_iso)"
{
  printf '{\n'
  printf '  "schema": "toolroll.app-captures/v1",\n'
  printf '  "surface": "%s",\n' "$surface"
  printf '  "device": "%s",\n' "$(json_escape "$device_type")"
  printf '  "os": "%s",\n' "$(json_escape "$os_version")"
  printf '  "state_key": "%s",\n' "$state_key"
  printf '  "commit": "%s",\n' "$commit"
  printf '  "captured_at": "%s",\n' "$captured_at"
  printf '  "captures": [\n'
  for ((k = 0; k < ${#entries[@]}; k++)); do
    sep=","; [ "$k" -eq $((${#entries[@]} - 1)) ] && sep=""
    printf '    %s%s\n' "${entries[$k]}" "$sep"
  done
  printf '  ]\n}\n'
} > "$incoming/index.json"
plutil -convert xml1 -o /dev/null "$incoming/index.json" >/dev/null 2>&1 || fail "the index written isn't JSON"

# The cache: one folder per state key, replaced whole.
final="$cache_dir/$state_key"
rm -rf "$final"
mv "$incoming" "$final"

# The mirror in the repo: never through a link, and only our own files are replaced.
mirror_parent="$repo"
for part in .youi screens toolroll "$surface"; do
  mirror_parent="$mirror_parent/$part"
  [ -L "$mirror_parent" ] && fail "${mirror_parent#"$repo"/} is a link, so the captures weren't mirrored into the repo"
  mkdir -p "$mirror_parent"
done
mirror="$mirror_parent"
find "$mirror" -maxdepth 1 -type f \( -name '*.png' -o -name 'index.json' \) -delete
cp "$final"/*.png "$final/index.json" "$mirror/"

echo "Captured ${#entries[@]} screens on $device_type ($os_version) at $commit, state $state_key"
echo "  cache:  $final"
echo "  mirror: $mirror"
if [ "${#failures[@]}" -gt 0 ]; then
  fail "${#failures[@]} screens weren't captured: ${failures[*]}"
fi
"""#
}

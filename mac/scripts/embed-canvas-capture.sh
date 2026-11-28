#!/bin/bash
# Writes scripts/canvas-capture-ios.sh into the Mac app's own code (ToolrollCore/CanvasCaptureScript.swift), so the
# Canvas always runs the capture script it shipped with, never one a project supplies.
# Usage: mac/scripts/embed-canvas-capture.sh [--check]   (--check: fail when the embedded copy is out of date)
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
src="$root/scripts/canvas-capture-ios.sh"
out="$root/mac/Sources/ToolrollCore/CanvasCaptureScript.swift"
if grep -q '"""#' "$src"; then echo "error: $src contains \"\"\"#, which ends the Swift raw string" >&2; exit 1; fi
render() {
  printf 'public enum CanvasCaptureScript {\n    public static let name = "canvas-capture-ios.sh"\n    public static let source = #"""\n'
  cat "$src"
  printf '"""#\n}\n'
}
if [ "${1:-}" = "--check" ]; then
  if ! render | cmp -s - "$out"; then
    echo "error: $out is out of date; run mac/scripts/embed-canvas-capture.sh" >&2
    exit 1
  fi
  exit 0
fi
render > "$out"

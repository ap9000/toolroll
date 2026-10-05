// A miniature suite for src/suite-lifecycle.test.ts: makes temp folders, starts a helper that ignores SIGTERM (as a
// dev server or browser might), says where both are, then passes, fails or hangs as asked.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, report] = process.argv.slice(2);
const made = mkdtempSync(join(tmpdir(), "so-fixture-"));
mkdirSync(join(made, "nested"));
writeFileSync(join(made, "nested", "file"), "x");
const helper = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", cwd: made });
helper.unref();
writeFileSync(report, JSON.stringify({ tmp: tmpdir(), made, helper: helper.pid, self: process.pid }));
if (mode === "pass") process.exit(0);
if (mode === "fail") process.exit(1);
setInterval(() => {}, 1000);

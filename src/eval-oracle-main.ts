/**
 * The eval oracle's process (eval-oracle.ts): started by the plane's runner from the installed release, outside the
 * fence, once an attempt's whole process tree is gone. It reads one request on stdin (the installed case's folder, the
 * graded files' folder, the time limit), grades, and writes one verdict line on stdout. It never reads anything the
 * build wrote except the named graded files, and never runs the build's code in its own process.
 */
import { gradeCase } from "./eval-oracle.js";

const chunks: Buffer[] = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += (chunk as Buffer).length;
  if (size > 16 * 1024) break;
  chunks.push(chunk as Buffer);
}
let verdict: { outcome: string; why: string | null };
try {
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { caseDir?: unknown; inputDir?: unknown; timeoutMs?: unknown; deny?: unknown };
  // What the graded program may not read beside the installed eval set (the plane's state folder): absolute paths only.
  const deny = Array.isArray(request.deny) ? request.deny.filter((one): one is string => typeof one === "string" && one.startsWith("/")).slice(0, 8) : [];
  if (typeof request.caseDir !== "string" || typeof request.inputDir !== "string" || !Number.isInteger(request.timeoutMs) || (request.timeoutMs as number) < 1 || (request.timeoutMs as number) > 600_000) {
    verdict = { outcome: "error", why: "the oracle was asked something it can't read" };
  } else {
    verdict = await gradeCase({ caseDir: request.caseDir, inputDir: request.inputDir, timeoutMs: request.timeoutMs as number, deny });
  }
} catch (error) {
  verdict = { outcome: "error", why: `the oracle failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` };
}
process.stdout.write(`${JSON.stringify(verdict)}\n`);

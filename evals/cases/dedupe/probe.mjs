// The graded program's launcher. The oracle copies this file from the installed case (never the build's copy) and
// runs it inside the fence with the nonce and inputs on stdin; only a line naming that nonce with the right outputs
// passes. Nothing here is visible to the agent while it builds.
import { readFileSync } from "node:fs";
const { nonce, inputs } = JSON.parse(readFileSync(0, "utf8"));
const attempt = run => { try { return run(); } catch { return { threw: true }; } };
const { dedupe } = await import("./dedupe.js");
const outputs = inputs.map(({ rows }) => attempt(() => {
  const copy = structuredClone(rows);
  const value = dedupe(copy);
  return { value, kept: JSON.stringify(copy) === JSON.stringify(rows), fresh: value !== copy };
}));
process.stdout.write(JSON.stringify({ nonce, outputs }) + "\n");

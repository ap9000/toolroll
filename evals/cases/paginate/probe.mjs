// The graded program's launcher. The oracle copies this file from the installed case (never the build's copy) and
// runs it inside the fence with the nonce and inputs on stdin; only a line naming that nonce with the right outputs
// passes. Nothing here is visible to the agent while it builds.
import { readFileSync } from "node:fs";
const { nonce, inputs } = JSON.parse(readFileSync(0, "utf8"));
const attempt = run => { try { return run(); } catch { return { threw: true }; } };
const { paginate } = await import("./paginate.js");
const outputs = inputs.map(({ args }) => attempt(() => {
  const items = structuredClone(args[0]);
  const value = paginate(items, ...args.slice(1));
  return { value, kept: JSON.stringify(items) === JSON.stringify(args[0]) };
}));
process.stdout.write(JSON.stringify({ nonce, outputs }) + "\n");

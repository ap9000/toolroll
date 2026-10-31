// The graded program's launcher. The oracle copies this file from the installed case (never the build's copy) and
// runs it inside the fence with the nonce and inputs on stdin; only a line naming that nonce with the right outputs
// passes. Nothing here is visible to the agent while it builds.
import { readFileSync } from "node:fs";
const { nonce, inputs } = JSON.parse(readFileSync(0, "utf8"));
const attempt = run => { try { return run(); } catch { return { threw: true }; } };
const { mergeConfig } = await import("./config.js");
const live = overrides => Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, value !== null && typeof value === "object" ? undefined : value]));
const outputs = inputs.map(({ base, overrides }) => attempt(() => {
  const b = structuredClone(base), o = live(overrides);
  const before = JSON.stringify(Object.entries(o));
  const value = mergeConfig(b, o);
  return { value, keptBase: JSON.stringify(b) === JSON.stringify(base), keptOverrides: JSON.stringify(Object.entries(o)) === before };
}));
process.stdout.write(JSON.stringify({ nonce, outputs }) + "\n");

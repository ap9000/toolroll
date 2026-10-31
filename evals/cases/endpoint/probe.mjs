// The graded program's launcher. The oracle copies this file from the installed case (never the build's copy) and
// runs it inside the fence with the nonce and inputs on stdin; only a line naming that nonce with the right outputs
// passes. Nothing here is visible to the agent while it builds.
import { readFileSync } from "node:fs";
const { nonce, inputs } = JSON.parse(readFileSync(0, "utf8"));
const attempt = run => { try { return run(); } catch { return { threw: true }; } };
const { validName } = await import("./validate.js");
const { createItem } = await import("./endpoint.js");
const outputs = inputs.map(input => attempt(() => ({ value: input.kind === "valid" ? validName(input.value) : createItem(input.body?.absent ? undefined : input.body) })));
process.stdout.write(JSON.stringify({ nonce, outputs }) + "\n");

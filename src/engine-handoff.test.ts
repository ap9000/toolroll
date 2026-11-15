/**
 * The terminal workbench's sign-in hand-off (engine-handoff.ts): the one-time link reaches the started program over its
 * descriptor 3 and nowhere else — not its arguments, not its environment — and a link that isn't a local one-time link,
 * or one already placed in the arguments or environment, is refused before anything starts.
 */
import { expect, test } from "vitest";
import { spawnWithLink, LINK_FD } from "./engine-handoff.js";

const LINK = `http://127.0.0.1:4720/login/once/${"A".repeat(20)}_${"b".repeat(22)}`;
/** A stand-in binary: reads fd 3, then says what it read and whether the code is in its arguments or environment. */
const PROBE = `const fs=require("fs");const read=fs.readFileSync(${LINK_FD},"utf8");const code=read.trim().split("/").pop();` +
  `process.stdout.write(JSON.stringify({read,argv:process.argv.join(" ").includes(code),env:JSON.stringify(process.env).includes(code)}))`;

test("the link arrives on descriptor 3 only", async () => {
  const child = spawnWithLink(process.execPath, ["-e", PROBE], LINK, { stdio: ["ignore", "pipe", "inherit"], env: { PATH: process.env["PATH"] ?? "" } });
  let out = "";
  child.stdout!.setEncoding("utf8").on("data", chunk => { out += chunk; });
  const code = await new Promise<number | null>(resolve => child.on("close", resolve));
  expect(code).toBe(0);
  expect(JSON.parse(out)).toEqual({ read: `${LINK}\n`, argv: false, env: false });
});

test("refused before anything starts: not a local one-time link, or the link already in the arguments or environment", () => {
  for (const bad of ["http://evil.example/login/once/" + "a".repeat(43), "http://127.0.0.1:4720/login/once/short", `${LINK}?x=1`, "/login/once/" + "a".repeat(43)]) {
    expect(() => spawnWithLink(process.execPath, ["-e", "0"], bad), bad).toThrow(/not a local one-time sign-in link/);
  }
  const code = LINK.slice(LINK.lastIndexOf("/") + 1);
  expect(() => spawnWithLink(process.execPath, ["--link", LINK], LINK)).toThrow(/only over the pipe/);
  expect(() => spawnWithLink(process.execPath, ["-e", "0"], LINK, { env: { TOOLROLL_LINK: code } })).toThrow(/only over the pipe/);
});

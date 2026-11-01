/** `project network` parses its own flags: --open/--allowlist switch the mode, --remove and --local take values. */
import { expect, test } from "vitest";
import { ownValueFlags, parseOperateArgs } from "./operate.js";

const parse = (argv: string[]) => parseOperateArgs(argv, ownValueFlags("project", argv));

test("--open and --allowlist are switches the parser knows", () => {
  for (const flag of ["--open", "--allowlist"]) {
    const parsed = parse(["network", "--repo", "/p", flag]);
    expect(parsed, flag).not.toHaveProperty("error");
    if (!("error" in parsed)) expect(parsed.flags.get(flag.slice(2))).toBe(true);
  }
});

test("--remove and --local take a value under project network, and stay switches elsewhere", () => {
  const parsed = parse(["network", "--repo", "/p", "--remove", "api.example.com", "--local", "none"]);
  expect(parsed).not.toHaveProperty("error");
  if (!("error" in parsed)) {
    expect(parsed.flags.get("remove")).toBe("api.example.com");
    expect(parsed.flags.get("local")).toBe("none");
    expect(parsed.positional).toEqual(["network"]);
  }
  const elsewhere = parseOperateArgs(["writes", "--repo", "/p", "--local"], ownValueFlags("project", ["writes"]));
  expect(elsewhere).not.toHaveProperty("error");
  if (!("error" in elsewhere)) expect(elsewhere.flags.get("local")).toBe(true);
});

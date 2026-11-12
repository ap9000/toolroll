import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without declarations
import { Screen, plainText, looksLikeStackTrace, createTrace, countsOf, splitsOf, totalOf, launchPlan, packageSource, realRunRefusal, PERSON_SECONDS } from "../scripts/first-result-kit.mjs";

describe("the first-result screen", () => {
  it("draws text, wraps at the edge and moves the cursor", () => {
    const screen = new Screen(4, 10);
    screen.write("hello\r\nworld");
    expect(screen.text()).toBe("hello\nworld");
    screen.write("\u001b[1;1HJ");
    expect(screen.text()).toBe("Jello\nworld");
    screen.write("\u001b[2;3H\u001b[K");
    expect(screen.text()).toBe("Jello\nwo");
  });

  it("reads an Ink-style redraw: erase the previous frame, draw the next", () => {
    const screen = new Screen(6, 40);
    screen.write("\u001b[?25lFirst frame\nline two\n");
    // eraseLines(3): erase, up, erase, up, erase, to column 1
    screen.write("\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[GSecond frame\n");
    expect(screen.text()).toBe("Second frame");
  });

  it("keeps a sequence cut between two writes, drops colours and titles, scrolls at the bottom", () => {
    const screen = new Screen(2, 20);
    screen.write("\u001b[1");
    screen.write("mbold\u001b[0m \u001b]0;title\u0007ok");
    expect(screen.text()).toBe("bold ok");
    screen.write("\nthree\nfour");
    expect(screen.text()).toBe("three\nfour");
    expect(screen.scrolled).toEqual(["bold ok"]);
  });

  it("clears the whole screen", () => {
    const screen = new Screen(3, 10);
    screen.write("a\nb\nc\u001b[2J\u001b[Hd");
    expect(screen.text()).toBe("d");
  });

  it("takes escape sequences out of a transcript and spots a stack trace", () => {
    expect(plainText("\u001b[1mBold\u001b[0m\r\nline")).toBe("Bold\nline");
    expect(looksLikeStackTrace("Error: boom\n    at run (/x/y.js:1:2)")).toBe(true);
    expect(looksLikeStackTrace("TypeError: cannot read")).toBe(true);
    expect(looksLikeStackTrace("Claude Code: not installed\n   To sign in, run: claude auth login")).toBe(false);
  });
});

describe("the first-result trace", () => {
  it("counts decisions, interactions and waits apart; a fallback counts and is marked", () => {
    let now = 1_000;
    const trace = createTrace("t", { now: () => now });
    trace.decision("pick a command", { surface: "shell" });
    trace.interaction("type it");
    trace.startClock();
    now += 2_000;
    const wait = trace.beginWait("starts");
    now += 3_000;
    wait({ screen: "drawn" });
    trace.mark("installed");
    trace.notPossible("accept here", "use the browser");
    trace.interaction("press w");
    trace.decision("looks right?", { surface: "browser" });
    trace.endFallback();
    trace.note("done");
    expect(trace.entries.slice(0, 2).every((one: { at: number; beforeClock?: boolean }) => one.at === 0 && one.beforeClock)).toBe(true);
    expect(trace.entries[2]).toMatchObject({ kind: "wait", at: 2, seconds: 3, screen: "drawn" });
    expect(trace.marks).toEqual({ clock: 0, installed: 5 });
    expect(countsOf(trace.entries)).toEqual({ decisions: 2, interactions: 2, waits: 1, waitSeconds: 3, notPossible: 1, fallback: 2 });
  });

  it("splits from the marks reached, and adds the person's allowance once", () => {
    const marks = { clock: 0, installed: 30, started: 40, "terms-shown": 50, filed: 55, approved: 52, "build-end": 120, ready: 125, accepted: 130 };
    const splits = Object.fromEntries(splitsOf(marks).map((one: { name: string; seconds: number | null }) => [one.name, one.seconds]));
    expect(splits).toEqual({ install: 30, start: 10, "first task filed": 10, "plan/approval": 2, build: 68, "result ready": 5, "reviewed/accepted": 5 });
    expect(totalOf(marks)).toEqual({ machineSeconds: 130, personSeconds: PERSON_SECONDS, totalSeconds: 130 + PERSON_SECONDS });
    expect(PERSON_SECONDS).toBe(60);
    expect(splitsOf({ clock: 0 }).every((one: { seconds: number | null }) => one.seconds === null)).toBe(true);
    expect(totalOf({ clock: 0 }).totalSeconds).toBeNull();
  });

  it("refuses an unknown kind or mark", () => {
    const trace = createTrace("t");
    expect(() => trace.step("think", "x")).toThrow();
    expect(() => trace.mark("lunch")).toThrow();
  });
});

describe("the first-result real run", () => {
  it("starts only on purpose: a package, the confirmation, and brew only with --allow-brew", () => {
    expect(realRunRefusal({ journeys: "scripted", pkg: null, confirmed: false, install: "local", allowBrew: false })).toBeNull();
    expect(realRunRefusal({ journeys: "real", pkg: "toolroll@1.2.3", confirmed: false, install: "npx", allowBrew: false })).toMatch(/on purpose/);
    expect(realRunRefusal({ journeys: "all", pkg: "toolroll@1.2.3", confirmed: false, install: "npx", allowBrew: false })).toMatch(/on purpose/);
    expect(realRunRefusal({ journeys: "real", pkg: null, confirmed: true, install: "npx", allowBrew: false })).toMatch(/--package/);
    expect(realRunRefusal({ journeys: "real", pkg: "toolroll@latest", confirmed: true, install: "npx", allowBrew: false })).toMatch(/--package/);
    expect(realRunRefusal({ journeys: "real", pkg: "toolroll@1.2.3", confirmed: true, install: "brew", allowBrew: false })).toMatch(/--allow-brew/);
    expect(realRunRefusal({ journeys: "real", pkg: "toolroll@1.2.3", confirmed: true, install: "yarn", allowBrew: false })).toMatch(/--install/);
    expect(realRunRefusal({ journeys: "real", pkg: "toolroll@1.2.3", confirmed: true, install: "npx", allowBrew: false })).toBeNull();
    expect(realRunRefusal({ journeys: "real", pkg: "toolroll@1.2.3", confirmed: true, install: "brew", allowBrew: true })).toBeNull();
  });

  it("knows a registry spec from a local package", () => {
    expect(packageSource("toolroll@0.9.104")).toEqual({ kind: "registry", spec: "toolroll@0.9.104", version: "0.9.104" });
    expect(packageSource("other@1.0.0")).toBeNull();
    expect(packageSource(".")?.kind).toBe("local");
    expect(packageSource("./no-such.tgz")).toBeNull();
  });

  it("runs each install path in the throwaway folder with an empty npm cache", () => {
    const npx = launchPlan({ install: "npx", pkg: "toolroll@1.2.3", root: "/r", localBin: "/b" });
    expect(npx).toMatchObject({ install: null, start: "npx -y toolroll@1.2.3", env: { npm_config_cache: "/r/npm-cache" } });
    const npm = launchPlan({ install: "npm", pkg: "toolroll@1.2.3", root: "/r", localBin: "/b" });
    expect(npm.install).toEqual({ command: "npm", args: ["install", "-g", "toolroll@1.2.3"], env: { npm_config_cache: "/r/npm-cache", npm_config_prefix: "/r/npm-prefix" } });
    expect(npm).toMatchObject({ start: "toolroll", path: ["/r/npm-prefix/bin"] });
    const brew = launchPlan({ install: "brew", pkg: "toolroll@1.2.3", root: "/r", localBin: "/b", brewPrefix: "/opt/homebrew" });
    expect(brew.install).toMatchObject({ command: "brew", args: ["install", "ap9000/toolroll/toolroll"], realHome: true });
    expect(brew.path).toEqual(["/opt/homebrew/bin"]);
    expect(launchPlan({ install: "local", pkg: null, root: "/r", localBin: "/b" })).toMatchObject({ install: null, start: "toolroll" });
  });
});

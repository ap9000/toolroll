// A .test.ts file (the suite's inventory, scripts/ci-shards.mjs INCLUDE, has no .tsx), so elements come from createElement.
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { sampleData } from "./data.js";

/** Lets Ink run the mount effects (useInput subscribes in one) before the first keypress. */
const mounted = () => new Promise(resolve => setImmediate(resolve));

afterEach(() => cleanup());

describe("terminal UI placeholder screen", () => {
  it("renders the list and the first item's detail", () => {
    const { lastFrame } = render(createElement(App, { data: sampleData() }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("> Sample: fix the login redirect");
    expect(frame).toContain("Editing src/auth.ts");
  });

  it("j moves the selection down and k back, clamped at the ends", async () => {
    const { lastFrame, stdin } = render(createElement(App, { data: sampleData() }));
    const shows = (text: string) => vi.waitFor(() => expect(lastFrame()).toContain(text));
    await mounted();
    stdin.write("j");
    await shows("> Sample: add CSV export");
    expect(lastFrame()).toContain("Waiting for your review");
    stdin.write("j");
    await shows("> Sample: upgrade the test runner");
    stdin.write("j");
    stdin.write("k");
    await shows("> Sample: add CSV export");
  });

  it("q exits", async () => {
    const onExit = vi.fn();
    const { stdin } = render(createElement(App, { data: sampleData(), onExit }));
    await mounted();
    stdin.write("q");
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
  });
});

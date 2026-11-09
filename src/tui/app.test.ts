// A .test.ts file (the suite's inventory, scripts/ci-shards.mjs INCLUDE, has no .tsx), so elements come from createElement.
// The screen against a scripted source: keys, screens and where a refusal leads. The real source (runOperate as the
// local owner, a temporary database) is src/tui-source.test.ts.
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { sampleSession, sampleSource, type TuiAct, type TuiSession, type TuiSource } from "./data.js";

/** Lets Ink run the mount effects (useInput subscribes in one) before the first keypress. */
const mounted = () => new Promise(resolve => setImmediate(resolve));
afterEach(() => cleanup());

function scripted(over: Partial<TuiSource> = {}): TuiSource & { acts: TuiAct[] } {
  const acts: TuiAct[] = [];
  const base = sampleSource();
  return { ...base, act: async one => { acts.push(one); return { ok: true, message: "Done." }; }, ...over, acts };
}
function show(app: ReturnType<typeof render>) {
  return (text: string) => vi.waitFor(() => expect(app.lastFrame()).toContain(text));
}

describe("terminal UI", () => {
  it("lists the tasks, what needs you, and the selected task's live output; j/k move", async () => {
    const app = render(createElement(App, { source: sampleSource(), session: sampleSession(), pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample: upgrade the test runner");
    await shows("1 task needs you");
    await mounted();
    app.stdin.write("j");
    await shows("> Sample: fix the login redirect");
    await shows("Editing src/auth.ts (sample)");
    app.stdin.write("j");
    await shows("> Sample: add CSV export");
    app.stdin.write("k");
    await shows("> Sample: fix the login redirect");
  });

  it("lists the tasks under Home's three headings, in Home's order, whatever order they arrive in; j/k follow the list", async () => {
    const base = sampleSource();
    const snapshot = await base.snapshot();
    const [you, working, done] = snapshot.rows;
    const cancelled = { ...done!, id: "t4", title: "Sample: drop the old banner", status: "Cancelled", group: null };
    const source = scripted({ snapshot: async () => ({ ...snapshot, rows: [cancelled, done!, working!, you!] }) });
    const app = render(createElement(App, { source, session: sampleSession(), pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample: upgrade the test runner");
    const frame = app.lastFrame() ?? "";
    // The list is the left column: the line each text first shows on there.
    const at = (text: string) => frame.split("\n").findIndex(line => { const column = line.indexOf(text); return column > -1 && column < 40; });
    for (const text of ["Waiting on you", "Working", "Done", "Other"]) expect(at(text), text).toBeGreaterThan(-1);
    expect(at("Waiting on you")).toBeLessThan(at("Sample: upgrade the test runner"));
    expect(at("Sample: upgrade the test runner")).toBeLessThan(at("Working"));
    expect(at("Working")).toBeLessThan(at("Sample: fix the login redirect"));
    expect(at("Sample: fix the login redirect")).toBeLessThan(at("Done"));
    expect(at("Done")).toBeLessThan(at("Sample: add CSV export"));
    expect(at("Sample: add CSV export")).toBeLessThan(at("Other"));
    expect(at("Other")).toBeLessThan(at("Sample: drop the old banner"));
    await mounted();
    app.stdin.write("j"); app.stdin.write("j"); app.stdin.write("j");
    await shows("> Sample: drop the old banner");
  });

  it("a shows the whole plan first; y approves exactly its digest; Esc approves nothing", async () => {
    const source = scripted();
    const app = render(createElement(App, { source, session: sampleSession(), pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample: upgrade the test runner");
    await mounted();
    app.stdin.write("a");
    await shows("Goal: upgrade the test runner (sample)");
    app.stdin.write("\u001b");
    await shows("Nothing approved.");
    expect(source.acts).toEqual([]);
    app.stdin.write("a");
    await shows("Approve this plan?");
    app.stdin.write("y");
    await vi.waitFor(() => expect(source.acts).toEqual([{ kind: "approve", id: "t3", digest: "sample" }]));
  });

  it("n files a new task from the composer; the first one asks once about the background", async () => {
    const source = scripted();
    let asked = 0;
    const answers: boolean[] = [];
    const session: TuiSession = { ...sampleSession(), owned: () => true, shouldAskBackground: () => asked++ === 0, answerBackground: async yes => { answers.push(yes); return "Okay."; } };
    const app = render(createElement(App, { source, session, pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample");
    await mounted();
    app.stdin.write("n");
    await shows("New task");
    app.stdin.write("Add a dark mode");
    await shows("Add a dark mode");
    app.stdin.write("\r");
    await vi.waitFor(() => expect(source.acts).toEqual([{ kind: "new", text: "Add a dark mode", repo: null }]));
    await shows("Keep Toolroll running in the background? (Y/n)");
    app.stdin.write("n");
    await vi.waitFor(() => expect(answers).toEqual([false]));
  });

  it("a refused write shows its words and leads to a password", async () => {
    const source = scripted({ act: async () => ({ ok: false, message: "Set a password, or sign in with your password, to do this.", needsPassword: true }) });
    const app = render(createElement(App, { source, session: sampleSession(), pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample");
    await mounted();
    app.stdin.write("c");
    await shows("Set a password, or sign in with your password, to do this.");
    await shows("Set a password: run `toolroll password set`");
  });

  it("q with agents this terminal started asks: stop them, or keep them running in the background", async () => {
    const onExit = vi.fn();
    const app = render(createElement(App, { source: sampleSource(), session: { ...sampleSession(), owned: () => true }, onExit, pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample");
    await mounted();
    app.stdin.write("q");
    await shows("Stop agents and quit");
    app.stdin.write("b");
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith("keep"));
  });

  it("q with nothing of its own running leaves at once", async () => {
    const onExit = vi.fn();
    const app = render(createElement(App, { source: sampleSource(), session: sampleSession(), onExit, pollMs: 20 }));
    await show(app)("> Sample");
    await mounted();
    app.stdin.write("q");
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith("leave"));
  });

  it("text an agent wrote can't redraw or hide the approval screen: escapes and controls show as nothing, the whole plan shows", async () => {
    const hostile = ["Goal: tidy the footer\x1b[2J", "\x1b]8;;https://evil.example\x07Read the docs\x1b]8;;\x07 first", "\x1b[1A\x1b[2KTouches: src/footer.ts", "\x9b2JAcceptance: the footer reads 2026", "Risk: none\rApproved already"];
    const base = sampleSource();
    const source = scripted({
      task: async id => {
        const task = await base.task(id);
        return task === null ? null : { ...task, title: `${task.title}\x1b[2J\x1b]0;owned\x07`, plan: task.plan === null ? null : { digest: "sample", lines: hostile } };
      },
    });
    const app = render(createElement(App, { source, session: sampleSession(), pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample: upgrade the test runner");
    await mounted();
    app.stdin.write("a");
    await shows("Approve this plan? Sample: upgrade the test runner");
    for (const line of ["Goal: tidy the footer", "Read the docs first", "Touches: src/footer.ts", "Acceptance: the footer reads 2026", "Risk: noneApproved already"]) await shows(line);
    const frame = app.lastFrame() ?? "";
    for (const trick of ["\x1b[2J", "\x1b]8;;", "\x1b]0;", "\x1b[1A", "\x1b[2K", "\x9b", "\r", "evil.example"]) expect(frame).not.toContain(trick);
  });
});


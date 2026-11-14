// A .test.ts file (the suite's inventory, scripts/ci-shards.mjs INCLUDE, has no .tsx), so elements come from createElement.
// The screen against a scripted source: keys, screens and where a refusal leads. The real source (runOperate as the
// local owner, a temporary database) is src/tui-source.test.ts.
import { cleanup, render } from "ink-testing-library";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import { sampleSession, sampleSource, type TuiAct, type TuiResult, type TuiSession, type TuiSource } from "./data.js";

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

  it("n files a new task from the composer and asks nothing more: the login-item question never interrupts a filing", async () => {
    const source = scripted();
    let asks = 0;
    const session: TuiSession = { ...sampleSession(), owned: () => true, shouldAskBackground: () => { asks += 1; return true; }, answerBackground: async () => "Okay." };
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
    await shows("Done.");
    expect(app.lastFrame()).not.toContain("Start Toolroll when you log in");
    expect(asks).toBe(0);
  });

  it("l1: after the first accepted result it asks once about the login item; no is the default (Enter), only y adds it", async () => {
    for (const [answer, expected] of [["\r", false], ["n", false], ["y", true]] as const) {
      const source = scripted();
      let asked = false;
      const answers: boolean[] = [];
      const session: TuiSession = { ...sampleSession(), owned: () => true, shouldAskBackground: () => !asked, answerBackground: async yes => { asked = true; answers.push(yes); return "Okay."; } };
      const app = render(createElement(App, { source, session, pollMs: 20 }));
      const shows = show(app);
      await shows("> Sample");
      await mounted();
      app.stdin.write("j"); app.stdin.write("j");
      await shows("> Sample: add CSV export");
      app.stdin.write("c");
      await shows("Did you check it yourself? (y/n)");
      app.stdin.write("y");
      await shows("Start Toolroll when you log in, so tasks keep going? (y/N)");
      app.stdin.write(answer);
      await vi.waitFor(() => expect(answers).toEqual([expected]));
      await shows("Okay.");
      cleanup();
    }
  });

  it("p asks for a plan bound to the planning source the task read; with none to ask, it sends nothing and says so", async () => {
    const base = sampleSource();
    const source = scripted({ task: async id => { const task = await base.task(id); return task === null ? null : { ...task, plan: null, planAsk: id === "t1" ? null : { source: "s".repeat(64) } }; } });
    const app = render(createElement(App, { source, session: sampleSession(), pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample: upgrade the test runner");
    await mounted();
    app.stdin.write("p");
    await vi.waitFor(() => expect(source.acts).toEqual([{ kind: "plan", id: "t3", source: "s".repeat(64) }]));
    app.stdin.write("j");
    await shows("> Sample: fix the login redirect");
    app.stdin.write("p");
    await shows("This task can't be planned now.");
    expect(source.acts).toHaveLength(1);
  });

  it("r shows the build to retry first; y sends exactly the build and plan read; Esc sends nothing; nothing to retry says so", async () => {
    const base = sampleSource();
    const source = scripted({ task: async id => { const task = await base.task(id); return task === null ? null : { ...task, retry: id === "t3" ? { runId: 7, digest: "d".repeat(32) } : null }; } });
    const app = render(createElement(App, { source, session: sampleSession(), pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample: upgrade the test runner");
    await mounted();
    app.stdin.write("r");
    await shows("Retry build #7?");
    app.stdin.write("\u001b");
    await shows("Nothing retried.");
    expect(source.acts).toEqual([]);
    app.stdin.write("r");
    await shows("Retry build #7?");
    app.stdin.write("y");
    await vi.waitFor(() => expect(source.acts).toEqual([{ kind: "retry", id: "t3", runId: 7, digest: "d".repeat(32) }]));
    await shows("j/k move");
    app.stdin.write("j");
    await shows("> Sample: fix the login redirect");
    app.stdin.write("r");
    await shows("Nothing to retry on this task.");
    expect(source.acts).toHaveLength(1);
  });

  it("a refused write shows its words and leads to a password", async () => {
    const source = scripted({ act: async () => ({ ok: false, message: "Set a password, or sign in with your password, to do this.", needsPassword: true }) });
    const app = render(createElement(App, { source, session: sampleSession(), pollMs: 20 }));
    const shows = show(app);
    await shows("> Sample");
    await mounted();
    app.stdin.write("j"); app.stdin.write("j");
    await shows("> Sample: add CSV export");
    app.stdin.write("c");
    await shows("Did you check it yourself? (y/n)");
    app.stdin.write("y");
    await shows("Set a password, or sign in with your password, to do this.");
    await shows("Set a password: run `toolroll password set`");
  });

  describe("Accept this result?", () => {
    const sample = (over: Partial<TuiResult> = {}): TuiResult => ({ id: "t2", runId: 2, digest: "d".repeat(64), title: "Sample: add CSV export", ready: true, blockers: [],
      summary: ["Added a CSV export button to the orders page."], files: { names: Array.from({ length: 12 }, (_, i) => `src/file-${i + 1}.ts`).slice(0, 10), more: 2 },
      requirements: [{ word: "Met", statement: "Orders export as CSV." }, { word: "You check", statement: "The CSV opens in a spreadsheet." }],
      checks: ["Can I merge? Not yet", "✓ Project checks passed on this commit"], owed: "person-check", ...over });
    async function onResult(source: TuiSource & { acts: TuiAct[] }) {
      const app = render(createElement(App, { source, session: sampleSession(), pollMs: 20 }));
      const shows = show(app);
      await shows("> Sample");
      await mounted();
      app.stdin.write("j"); app.stdin.write("j");
      await shows("> Sample: add CSV export");
      return { app, shows };
    }

    it("c and a open it, pinned when it opens: the summary, changed files, requirements and checks; y sends exactly those pins with the person's yes", async () => {
      for (const key of ["c", "a"]) {
        let reads = 0;
        const source = scripted({ result: async () => { reads += 1; return sample(); } });
        const { app, shows } = await onResult(source);
        app.stdin.write(key);
        await shows("Accept this result? Sample: add CSV export");
        for (const line of ["Added a CSV export button", "src/file-10.ts", "and 2 more", "Met: Orders export as CSV.", "You check: The CSV opens in a spreadsheet.", "Can I merge? Not yet", "Did you check it yourself? (y/n)"]) await shows(line);
        expect(source.acts).toEqual([]);
        app.stdin.write("y");
        await vi.waitFor(() => expect(source.acts).toEqual([{ kind: "complete", id: "t2", runId: 2, digest: "d".repeat(64), checked: true, reason: null }]));
        expect(reads).toBe(1);
        cleanup();
      }
    });

    it("Esc and n accept nothing", async () => {
      const source = scripted({ result: async () => sample() });
      const { app, shows } = await onResult(source);
      app.stdin.write("c");
      await shows("Did you check it yourself? (y/n)");
      app.stdin.write("n");
      await shows("Nothing accepted.");
      app.stdin.write("c");
      await shows("Did you check it yourself? (y/n)");
      app.stdin.write("\u001b");
      await shows("Nothing accepted.");
      expect(source.acts).toEqual([]);
    });

    it("b pins the build it read before the note is typed, and sends exactly that build back; a task with no result says so", async () => {
      let reads = 0;
      const source = scripted({ result: async id => { reads += 1; return id === "t2" ? sample() : null; } });
      const app = render(createElement(App, { source, session: sampleSession(), pollMs: 20 }));
      const shows = show(app);
      await shows("> Sample: upgrade the test runner");
      await mounted();
      app.stdin.write("b");
      await shows("This task has no finished result to send back.");
      app.stdin.write("j"); app.stdin.write("j");
      await shows("> Sample: add CSV export");
      app.stdin.write("b");
      await shows("What should change?");
      app.stdin.write("Round the totals");
      await shows("Round the totals");
      app.stdin.write("\r");
      await vi.waitFor(() => expect(source.acts).toEqual([{ kind: "revise", id: "t2", text: "Round the totals", runId: 2 }]));
      // Read once, when b was pressed (and once for the task with none): never again before it is sent.
      expect(reads).toBe(2);
    });

    it("an exception asks why: empty or spaces send nothing; the words typed are sent with the pins", async () => {
      const source = scripted({ result: async () => sample({ owed: "exception", requirements: [{ word: "Not shown yet", statement: "A screenshot of the export." }] }) });
      const { app, shows } = await onResult(source);
      app.stdin.write("c");
      await shows("Say why you accept it anyway:");
      app.stdin.write("\r");
      app.stdin.write("   ");
      app.stdin.write("\r");
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(source.acts).toEqual([]);
      app.stdin.write("The export button is unchanged");
      await shows("The export button is unchanged");
      app.stdin.write("\r");
      await vi.waitFor(() => expect(source.acts).toEqual([{ kind: "complete", id: "t2", runId: 2, digest: "d".repeat(64), checked: false, reason: "The export button is unchanged" }]));
    });

    it("nothing owed: y accepts without claiming a check; a result that can't be accepted yet says why and offers no yes", async () => {
      const plain = scripted({ result: async () => sample({ owed: null }) });
      const first = await onResult(plain);
      first.app.stdin.write("c");
      await first.shows("Accept it and mark the task done? (y/n)");
      first.app.stdin.write("y");
      await vi.waitFor(() => expect(plain.acts).toEqual([{ kind: "complete", id: "t2", runId: 2, digest: "d".repeat(64), checked: false, reason: null }]));
      cleanup();
      const blocked = scripted({ result: async () => sample({ ready: false, blockers: ["Checks failed (exit 1). Fix them and run checks again, or send it back."] }) });
      const second = await onResult(blocked);
      second.app.stdin.write("c");
      await second.shows("You can't accept it yet.");
      await second.shows("Checks failed (exit 1).");
      second.app.stdin.write("y");
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(blocked.acts).toEqual([]);
    });

    it("the result changed meanwhile: refused, said plainly, and the new one shown; its own pins are what the next yes sends", async () => {
      let reads = 0;
      const acts: TuiAct[] = [];
      const source = scripted({
        result: async () => (reads++ === 0 ? sample() : sample({ runId: 3, digest: "e".repeat(64), summary: ["Added the CSV export, with a header row."] })),
        act: async one => { acts.push(one); return acts.length === 1 ? { ok: false, message: "This result changed. Look at the new one before accepting it.", needsPassword: false, changed: true } : { ok: true, message: "Accepted. The task is done." }; },
      });
      const { app, shows } = await onResult(source);
      app.stdin.write("c");
      await shows("Did you check it yourself? (y/n)");
      app.stdin.write("y");
      await shows("This result changed while you were reading it. This is the new one.");
      await shows("Build #3");
      await shows("Added the CSV export, with a header row.");
      app.stdin.write("y");
      await shows("Accepted. The task is done.");
      expect(acts).toEqual([
        { kind: "complete", id: "t2", runId: 2, digest: "d".repeat(64), checked: true, reason: null },
        { kind: "complete", id: "t2", runId: 3, digest: "e".repeat(64), checked: true, reason: null },
      ]);
    });
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

  it("its `up` stopping on its own is said at once in place of progress; no task then reads Planning or Building", async () => {
    const STOPPED = "Toolroll's background worker stopped. Run `toolroll --verbose` to see why.";
    const base = sampleSource();
    const snapshot = await base.snapshot();
    const planning = { ...snapshot.rows[1]!, title: "Add a subtract function", status: "Planning", detail: "The lead is writing the plan." };
    const acts: TuiAct[] = [];
    const source = scripted({
      snapshot: async () => ({ ...snapshot, rows: [planning] }),
      act: async one => { acts.push(one); return { ok: true, message: "Filed. Planning: you'll approve the plan before anything is built." }; },
    });
    let alive = true;
    const session: TuiSession = { ...sampleSession(), owned: () => alive, stopped: () => (alive ? null : STOPPED) };
    const app = render(createElement(App, { source, session, pollMs: 20 }));
    const shows = show(app);
    await shows("> Add a subtract function Planning");
    await mounted();
    alive = false;
    await shows(STOPPED);
    await shows("> Add a subtract function Waiting");
    expect(app.lastFrame()).not.toContain("Planning");
    app.stdin.write("n");
    await shows("New task");
    app.stdin.write("Add a divide function");
    await shows("Add a divide function");
    app.stdin.write("\r");
    await vi.waitFor(() => expect(acts).toHaveLength(1));
    await shows(STOPPED);
    expect(app.lastFrame()).not.toContain("Planning");
  });
});

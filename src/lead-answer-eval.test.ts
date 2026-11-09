/** The lead-answer eval in scripted mode (CI): the harness, the router, escalation and grading, end to end, with no
 * provider call. Its real mode (`node scripts/lead-answer-eval.mjs --real`) is the gate on turning quick answers on. */
import { describe, expect, test } from "vitest";
import { gradeAnswer, leadAnswerQuestions, runLeadAnswerEval } from "./lead-answer-eval.js";
import { quickRoute } from "./lead-route.js";

describe("the lead-answer eval", () => {
  test("30 read questions the router sends quick, 8 act questions it keeps, 2 soft acts only escalation catches", () => {
    const questions = leadAnswerQuestions();
    const route = (text: string) => quickRoute({ enabled: true, provider: "claude-subscription", mainModel: "opus", message: text, hasContext: false, hasReplyImage: false, askOpen: false, quickModel: "claude-sonnet-5-5", quickAllowed: true }).route;
    const read = questions.filter(one => one.kind === "read"), acts = questions.filter(one => one.kind === "act");
    expect(read).toHaveLength(30);
    expect(acts).toHaveLength(10);
    expect(new Set(questions.map(one => one.id)).size).toBe(40);
    for (const one of read) expect([one.text, route(one.text)]).toEqual([one.text, "fast"]);
    expect(acts.filter(one => route(one.text) === "default")).toHaveLength(8);
    for (const one of read) expect(one.mustName.length).toBeGreaterThan(0);
  });

  test("grading reads the oracle: every fact named, false claims counted", () => {
    const running = leadAnswerQuestions().find(one => one.id === "running-1")!;
    expect(gradeAnswer(running, "Running: Add CSV export to the orders page; Speed up the search index.")).toEqual({ named: true, falseClaims: 0 });
    expect(gradeAnswer(running, "Running: Add CSV export to the orders page. Also Compress product images.")).toEqual({ named: false, falseClaims: 1 });
  });

  test("scripted mode passes: same facts on both models, every act kept or escalated, the quick route faster", async () => {
    const report = await runLeadAnswerEval({ mode: "scripted" });
    expect(report.reasons).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.read.main.passK).toBe(30);
    expect(report.read.quick.passK).toBe(30);
    expect(report.act).toEqual({ kept: 10, total: 10, failures: [] });
    expect(report.runs.filter(one => one.model === "quick" && one.question.startsWith("act-soft")).every(one => one.route === "escalated")).toBe(true);
    expect(report.runs.filter(one => one.model === "quick" && !one.question.startsWith("act")).every(one => one.route === "fast")).toBe(true);
    expect(report.runs.filter(one => one.model === "main").every(one => one.route === "default")).toBe(true);
  }, 60_000);
});

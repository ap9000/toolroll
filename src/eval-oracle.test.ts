/**
 * The eval oracle (docs/plans/evals-nightly.md, part C, "Grading"): only the answer for this grading's nonce passes,
 * never an exit code, an edited launcher, a link, a file the build wrote, a replayed answer or the hidden check itself.
 * The attacks run the graded program inside the real native fence; the case table checks each shipped case's own
 * oracle against a correct and a broken build, through a plain child process (it is about the answers, not the fence).
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { linuxFenceAvailable, macosFenceAvailable } from "./agent-fence.js";
import { gradeCase, runOracle, type GradeRunner } from "./eval-oracle.js";
import { EVALS_ROOT, loadEvalSet } from "./evals.js";

const FENCED = macosFenceAvailable() || linuxFenceAvailable();
const CASE = (id: string) => join(EVALS_ROOT, "cases", id);
let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "so-eval-oracle-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** The build's graded files, as the runner would have extracted them. */
function built(files: Record<string, string>): string {
  const inputs = join(dir, `in-${Math.random().toString(36).slice(2)}`);
  mkdirSync(inputs);
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(inputs, path, ".."), { recursive: true }); writeFileSync(join(inputs, path), body); }
  return inputs;
}

/** Test only: the probe in a plain child process, for checking each case's answers (never the fence's job). */
const plain: GradeRunner = ({ cwd, stdin, timeoutMs }) => new Promise(done => {
  const child = execFile(process.execPath, ["probe.mjs"], { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
    done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout: String(stdout), timedOut: error?.killed === true });
  });
  child.stdin?.end(stdin);
});

const PAGINATE_RIGHT = "export const paginate = (items, offset = 0, limit = 10) => { const from = Math.max(0, offset); return items.slice(from, from + limit); };\n";
const PAGINATE_WRONG = "export const paginate = (items, offset, limit) => items.splice(offset || 0, limit || 10);\n";
const MATH = "export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\nexport const multiply = (a, b) => a * b;\nexport const divide = (a, b) => { if (b === 0) throw new Error('division by zero'); return a / b; };\n";
const RIGHT: Record<string, Record<string, string>> = {
  paginate: { "paginate.js": PAGINATE_RIGHT },
  dedupe: { "dedupe.js": "export const dedupe = rows => { const seen = new Set(); return rows.filter(r => { const k = typeof r.id + ':' + r.id; if (seen.has(k)) return false; seen.add(k); return true; }); };\n" },
  catalog: {
    "slug.js": "export const slug = text => text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n",
    "catalog.js": "import { slug } from './slug.js';\nexport const catalog = titles => { const out = titles.map(title => ({ title, slug: slug(title) })); if (new Set(out.map(o => o.slug)).size !== out.length) throw new Error('duplicate'); return out; };\n",
  },
  endpoint: {
    "validate.js": "export const validName = v => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 20;\n",
    "endpoint.js": "import { validName } from './validate.js';\nexport const createItem = body => validName(body?.name) ? { status: 201, body: { name: body.name.trim() } } : { status: 400, body: { error: 'invalid name' } };\n",
  },
  "csv-quoting": { "csv.js": "const cell = v => { const t = String(v); return /[\",\\n]/.test(t) ? '\"' + t.replace(/\"/g, '\"\"') + '\"' : t; };\nexport const csv = rows => rows.length === 0 ? '' : rows.map(r => r.map(cell).join(',')).join('\\r\\n') + '\\r\\n';\n" },
  "merge-config": { "config.js": "export const mergeConfig = (base, overrides) => { const out = { ...base }; for (const [k, v] of Object.entries(overrides)) { if (v === undefined) continue; if (v === null) delete out[k]; else out[k] = v; } return out; };\n" },
  "math-subtract": { "src/math.js": MATH },
  "math-divide": { "src/math.js": MATH },
  "math-multiply": { "src/math.js": MATH },
};

describe("each shipped build case's hidden check", () => {
  const set = loadEvalSet();
  if (!set.ok) throw new Error(set.problem);
  const builds = set.cases.filter(one => one.kind === "build");
  test("covers every build case", () => expect(builds.map(one => one.id).sort()).toEqual(Object.keys(RIGHT).sort()));
  test.each(builds.map(one => [one.id, one] as const))("%s: a correct build passes; the fixture as it started doesn't", async (_id, one) => {
    expect(await gradeCase({ caseDir: one.dir, inputDir: built(RIGHT[one.id]!), timeoutMs: 20_000, runner: plain })).toEqual({ outcome: "pass", why: null });
    const start = Object.fromEntries(Object.entries(one.fixture).filter(([path]) => "files" in one.grade && one.grade.files.includes(path)));
    expect((await gradeCase({ caseDir: one.dir, inputDir: built(start), timeoutMs: 20_000, runner: plain })).outcome).toBe("fail");
  });
});

describe.skipIf(!FENCED)("the oracle, against the real fence", () => {
  const grade = (files: Record<string, string>, timeoutMs = 20_000) => gradeCase({ caseDir: CASE("paginate"), inputDir: built(files), timeoutMs });

  test("a correct build passes inside the fence", async () => {
    expect(await grade({ "paginate.js": PAGINATE_RIGHT })).toEqual({ outcome: "pass", why: null });
  });

  const NO_ANSWER = /exited without an answer \(an exit code alone never passes\)/;
  const CRASHED = /crashed without an answer/;
  test.each([
    ["process.exit(0) before the probe can answer", { "paginate.js": `process.exit(0);\n${PAGINATE_RIGHT}` }, NO_ANSWER],
    ["an exit code of 0 with words that claim a pass", { "paginate.js": `console.log('PASS: every check passed'); process.exit(0);\n` }, NO_ANSWER],
    ["an edited launcher shipped beside a wrong build (the case's own launcher runs)", { "paginate.js": PAGINATE_WRONG, "probe.mjs": `import { readFileSync } from "node:fs";\nconst { nonce, inputs } = JSON.parse(readFileSync(0, "utf8"));\nconst paginate = ${PAGINATE_RIGHT.replace("export const paginate = ", "").trim()}\nconsole.log(JSON.stringify({ nonce, outputs: inputs.map(({ args }) => ({ value: paginate(...args), kept: true })) }));\n` }, /wrong answer/],
    ["an import of a file the oracle never copies", { "paginate.js": "export { paginate } from './answers.js';\n", "answers.js": PAGINATE_RIGHT }, CRASHED],
    ["a forged result file and verdict beside a crashing build", { "paginate.js": "throw new Error('broken');\n", "verdict.json": '{"outcome":"pass"}', "result.json": '{"outcome":"pass","why":null}' }, CRASHED],
    ["a module that prints a replayed answer for another nonce", { "paginate.js": "process.stdout.write(JSON.stringify({ nonce: '0'.repeat(32), outputs: [] }) + '\\n'); process.exit(0);\n" }, NO_ANSWER],
    // Codex round 1 #11: the right answer and then a crash, or a nonzero exit, is a fail.
    ["the right answer, then a throw", { "paginate.js": `${PAGINATE_RIGHT}process.on("exit", () => {}); setTimeout(() => { throw new Error("late crash"); }, 0);\n` }, /exited with 1 after answering/],
    ["the right answer, then exit 3", { "paginate.js": `${PAGINATE_RIGHT}process.on("beforeExit", () => process.exit(3));\n` }, /exited with 3 after answering/],
    ["more than 64 KiB of output", { "paginate.js": "process.stdout.write('x'.repeat(200 * 1024)); export const paginate = () => [];\n" }, /more than 65536 bytes/],
  ])("%s fails", async (_name, files, why) => {
    expect(await grade(files)).toEqual({ outcome: "fail", why: expect.stringMatching(why) });
  });

  test("the hidden check can't be read from inside the fence (outside it, the same build would pass)", async () => {
    const reader = { "paginate.js": `const { expected } = await import(${JSON.stringify(join(EVALS_ROOT, "cases", "paginate", "oracle.mjs"))});\nexport const paginate = (...args) => expected({ args }).value;\n` };
    expect(await grade(reader)).toEqual({ outcome: "fail", why: expect.stringMatching(CRASHED) });
    expect((await gradeCase({ caseDir: CASE("paginate"), inputDir: built(reader), timeoutMs: 20_000, runner: plain })).outcome).toBe("pass");
  });

  test("a build that never finishes fails on the time limit", async () => {
    expect(await grade({ "paginate.js": "await new Promise(() => setInterval(() => {}, 1000));\nexport const paginate = () => [];\n" }, 1_500)).toEqual({ outcome: "fail", why: "the graded program timed out" });
  });

  test("a graded file that is a link is refused, even to a correct build", async () => {
    const elsewhere = join(dir, "elsewhere.js");
    writeFileSync(elsewhere, PAGINATE_RIGHT);
    const inputs = built({});
    symlinkSync(elsewhere, join(inputs, "paginate.js"));
    expect(await gradeCase({ caseDir: CASE("paginate"), inputDir: inputs, timeoutMs: 20_000 })).toEqual({ outcome: "fail", why: "the build's paginate.js is a link, not a file" });
    // A graded folder that is itself a link isn't graded at all.
    const linked = join(dir, "linked");
    symlinkSync(built({ "paginate.js": PAGINATE_RIGHT }), linked);
    expect((await gradeCase({ caseDir: CASE("paginate"), inputDir: linked, timeoutMs: 20_000 })).outcome).toBe("error");
  });

  test("the oracle is its own process: a verdict only from it, and a case outside the installed set is an error", async () => {
    expect(await runOracle({ caseDir: CASE("paginate"), inputDir: built({ "paginate.js": PAGINATE_RIGHT }), timeoutMs: 20_000 })).toEqual({ outcome: "pass", why: null });
    const fake = join(dir, "case");
    mkdirSync(fake);
    writeFileSync(join(fake, "oracle.mjs"), "export const files = []; export const inputs = () => []; export const expected = () => null;\n");
    writeFileSync(join(fake, "probe.mjs"), "");
    expect(await runOracle({ caseDir: fake, inputDir: built({}), timeoutMs: 20_000 })).toEqual({ outcome: "error", why: "the case isn't one of the installed eval set" });
  }, 60_000);
});

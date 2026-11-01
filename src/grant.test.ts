import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.js";
import {
  permits,
  proposeGrant,
  describeGrant,
  describeWithheld,
  DEFAULT_MUTATIONS,
  type BackendGrant,
  type Runner,
  type WriteRequest,
} from "./grant.js";

const OK = { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };
const T0 = new Date("2026-08-11T22:00:00.000Z");

const grant = (over: Partial<BackendGrant> = {}): BackendGrant => ({
  repo: "/code/thing",
  backend: "beads",
  paths: [".beads"],
  mutations: [...DEFAULT_MUTATIONS],
  selector: "ours",
  credentialScope: null,
  observedByGit: false,
  grantedAt: T0.toISOString(),
  grantedBy: "operator",
  ...over,
});

const request = (over: Partial<WriteRequest> = {}): WriteRequest => ({
  repo: "/code/thing",
  backend: "beads",
  mutation: "create",
  origin: "ours",
  ...over,
});

describe("permits", () => {
  test("refuses everything without a grant", () => {
    // Silence is not consent. There is no implicit, inherited, or default
    // permission anywhere — an unenrolled repo is simply refused.
    const verdict = permits(null, request());

    expect(verdict).toMatchObject({ ok: false, reason: "no-grant" });
    if (!verdict.ok) expect(verdict.message).toContain("toolroll enroll");
  });

  test("allows what was granted", () => {
    expect(permits(grant(), request({ mutation: "transition" })).ok).toBe(true);
  });

  test("refuses a mutation class that was not granted", () => {
    // `close` is off by default: closing an issue somebody else filed is not
    // the same act as transitioning the task we are working on.
    const verdict = permits(grant(), request({ mutation: "close" }));

    expect(verdict).toMatchObject({ ok: false, reason: "mutation" });
  });

  test("keeps an enrolment from becoming an amnesty over a whole backlog", () => {
    // The default selector covers only tasks Toolroll created or was
    // given. Enrolling a repo with four hundred open issues is not
    // volunteering all four hundred to an unattended agent.
    expect(permits(grant(), request({ origin: "theirs" })).ok).toBe(false);
    expect(permits(grant(), request({ origin: "ours" })).ok).toBe(true);
  });

  test("covers everything only when explicitly widened", () => {
    expect(permits(grant({ selector: "all" }), request({ origin: "theirs" })).ok).toBe(true);
  });

  test("refuses a path outside the grant", () => {
    // A grant over `.beads/` must not become a licence to edit the tree.
    const verdict = permits(grant(), request({ path: "src/index.ts" }));

    expect(verdict).toMatchObject({ ok: false, reason: "path" });
  });

  test("refuses a grant that belongs to a different repo or backend", () => {
    // A caller that looked up the wrong grant — or reused one across
    // repositories in a loop — must not have repo A's permission applied to
    // repo B. Checking here removes a whole class of confused-deputy bug that
    // no amount of care at the call site can rule out.
    expect(permits(grant(), request({ repo: "/code/other" })).ok).toBe(false);
    expect(permits(grant(), request({ backend: "github-issues" })).ok).toBe(false);
  });

  test("does not let a path climb out of the granted scope", () => {
    // `.beads/../src/index.ts` starts with `.beads/`, so a naive prefix check
    // turns a grant over a tracker's data into a licence to rewrite the tree.
    expect(permits(grant(), request({ path: ".beads/../src/index.ts" })).ok).toBe(false);
    expect(permits(grant(), request({ path: ".beads/./issues.jsonl" })).ok).toBe(true);
    expect(permits(grant(), request({ path: ".beads/nested/../ok.jsonl" })).ok).toBe(true);
  });

  test("refuses a path that climbs above the repository altogether", () => {
    expect(permits(grant(), request({ path: "../../etc/passwd" })).ok).toBe(false);
  });

  test("matches paths on segment boundaries, not on prefixes", () => {
    // `.beads-backup` is not inside `.beads`, however it sorts.
    expect(permits(grant(), request({ path: ".beads/issues.jsonl" })).ok).toBe(true);
    expect(permits(grant(), request({ path: ".beads-backup/x" })).ok).toBe(false);
  });

  test("does not care which slash the caller used", () => {
    expect(permits(grant(), request({ path: ".beads\\issues.jsonl" })).ok).toBe(true);
  });

  test("gives a stable reason for each refusal", () => {
    // An agent branches on these; the prose beside them is for the human
    // reading the transcript afterwards.
    const reasons = [
      permits(null, request()),
      permits(grant(), request({ mutation: "close" })),
      permits(grant(), request({ origin: "theirs" })),
      permits(grant(), request({ path: "elsewhere" })),
    ].map(verdict => (verdict.ok ? "ok" : verdict.reason));

    expect(reasons).toEqual(["no-grant", "mutation", "selector", "path"]);
  });
});

describe("proposeGrant", () => {
  const runner = (code: number): Runner => async () => ({ ...OK, code });

  test("reports writes as visible when git is not ignoring them", async () => {
    // `git check-ignore` exits 1 when a path is NOT ignored, so the
    // interesting answer is the failure. A tracked .beads/ means every task
    // transition turns up in `git status`.
    const proposed = await proposeGrant({
      repo: "/code/thing",
      backend: "beads",
      paths: [".beads"],
      now: T0,
      runner: runner(1),
    });

    expect(proposed.observedByGit).toBe(true);
  });

  /** A real project whose .gitignore says `.beads/` (git's check-ignore runs through a frozen read view of it). */
  const ignoring = (): string => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "so-grant-")));
    execFileSync("git", ["init", "-q", repo], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    writeFileSync(join(repo, ".gitignore"), ".beads/\n");
    return repo;
  };

  test("reports writes as local when git ignores them", async () => {
    const repo = ignoring();
    try {
      const proposed = await proposeGrant({ repo, backend: "beads", paths: [".beads"], now: T0, runner: run });
      expect(proposed.observedByGit).toBe(false);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("sees a directory-only ignore rule for a directory that does not exist yet", async () => {
    // The state at enrolment: `.gitignore` says `.beads/`, and beads has not
    // run, so nothing is there. Asked about the bare path git says "not
    // ignored", because it cannot tell an absent path is a directory — and
    // the grant would then promise commits that are never going to happen.
    const repo = ignoring();
    try {
      const asked: string[] = [];
      const proposed = await proposeGrant({ repo, backend: "beads", paths: [".beads"], now: T0,
        runner: async (file, args, options) => { if (args.includes("check-ignore")) asked.push(String(args[args.length - 1])); return run(file, args, options); } });
      expect(asked).toContain(".beads/");
      expect(proposed.observedByGit).toBe(false);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  test("eval review 1 #7: an include naming a FIFO is refused, never read: the check ends, and errs toward visible", async () => {
    if (process.platform === "win32") return;
    const repo = ignoring();
    try {
      const fifo = join(repo, "hang.fifo");
      execFileSync("mkfifo", [fifo]);
      execFileSync("git", ["-C", repo, "config", "include.path", fifo], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      const proposed = await proposeGrant({ repo, backend: "beads", paths: [".beads"], now: T0, runner: run });
      expect(proposed.observedByGit).toBe(true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }, 20_000);

  test("errs toward visible when it could not find out", async () => {
    // Claiming writes are invisible when nobody established it is the wrong
    // way to be wrong — somebody would find out at their next commit.
    const proposed = await proposeGrant({
      repo: "/code/thing",
      backend: "beads",
      paths: [".beads"],
      now: T0,
      runner: async () => ({ ...OK, code: 127, notFound: true }),
    });

    expect(proposed.observedByGit).toBe(true);
  });

  test("does not ask git about a GitHub tracker", async () => {
    // `owner/name` is not a file, and running check-ignore on it would answer
    // a question nobody asked.
    let asked = false;
    const proposed = await proposeGrant({
      repo: "/code/thing",
      backend: "github-issues",
      paths: ["ap9000/vamarketplacenew"],
      now: T0,
      runner: async () => {
        asked = true;
        return { ...OK, code: 1 };
      },
    });

    expect(asked).toBe(false);
    expect(proposed.observedByGit).toBe(false);
  });

  test("withholds `close` unless it is asked for", async () => {
    const proposed = await proposeGrant({
      repo: "/code/thing",
      backend: "beads",
      paths: [".beads"],
      now: T0,
      runner: runner(0),
    });

    expect(proposed.mutations).not.toContain("close");
    expect(proposed.selector).toBe("ours");
  });
});

describe("describeGrant", () => {
  test("says what may be touched, done, and seen", () => {
    const lines = describeGrant(grant({ observedByGit: true })).join("\n");

    expect(lines).toContain(".beads");
    expect(lines).toContain("only those Toolroll created or was given");
    expect(lines).toContain("git status");
  });

  test("names what is withheld, which is the half people skip", () => {
    expect(describeWithheld(grant()).join("\n")).toContain("close");
  });

  test("says nothing about withholding when nothing is withheld", () => {
    const everything = grant({ mutations: ["create", "transition", "edge", "hold", "close", "comment"] });

    expect(describeWithheld(everything)).toEqual([]);
  });

  test("does not claim credentials it was not given", () => {
    expect(describeGrant(grant()).join("\n")).toContain("none of its own");
  });
});

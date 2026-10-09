import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { html, htmlString } from "./html.js";
import { withFormToken } from "./server/request-context.js";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { openStore, type Store } from "./store.js";
import { addApprover, propose, approve } from "./scope.js";
import { register } from "./runner.js";
import { createDecisionServer } from "./serve.js";
import { storeEvidence } from "./evidence.js";
import { verifyApproverStanding } from "./principal.js";
import { executeLeadTool } from "./lead-tools.js";
import { chatControlHref } from "./chat-controls.js";
import {
  changeSkills,
  conversationSkills,
  freezeSkills,
  githubSkill,
  importSkill,
  readSkillsSnapshot,
  reviseSkillTest,
  skillTestResult,
  skillReviewSource,
  skillsContext,
  skillsView,
  skillsVersion,
  selectProjectSkills,
  testSkill,
  validateSkill,
  type SkillFile,
} from "./project-skills.js";
import { skillsHtml, skillsSnapshotHtml } from "./skills-ui.js";
import { learningIdentity, learningSha } from "./project-learning.js";
import { savedRows } from "../test/context-fixture.js";

const main = (body = "Use short button labels.", name = "copy-review") =>
  `---\nname: ${name}\ndescription: |\n  Review interface copy and suggest clearer labels.\n---\n${body}\n`;
const file = (path: string, content: string): SkillFile => ({
  path,
  base64: Buffer.from(content).toString("base64"),
});
describe("managed project skills", () => {
  let root: string,
    repo: string,
    db: string,
    store: Store,
    password: string,
    head: string;
  let serial = 0;
  const now = new Date("2026-09-16T12:00:00Z");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "skills-test-")));
    repo = join(root, "repo");
    db = join(root, "test.db");
    mkdirSync(repo);
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "Skill test project");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-qm",
      "seed",
    );
    head = git("rev-parse", "HEAD");
    store = openStore(db);
    const user = addApprover(store, "alex", now);
    if (!user.ok) throw Error("fixture");
    password = user.token;
    for (const phase of ["plan", "build", "review"] as const)
      store.setPhaseConfig(
        "installation",
        phase,
        "claude",
        "sonnet",
        "fixture",
        now,
      );
    register(store, {
      name: "runner",
      host: "test",
      capacity: 100,
      repos: [repo],
      now,
      newToken: () => "runner-token",
    });
  });
  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const view = () => skillsView(store, repo, "alex");
  const add = (body?: string, name?: string) =>
    importSkill(
      store,
      repo,
      "alex",
      [
        file("SKILL.md", main(body, name)),
        file("references/style.md", "Use readable labels."),
      ],
      "Uploaded local folder",
      now,
    );
  const change = (sha: string, action: "enable" | "disable" = "enable") => {
    const v = view();
    changeSkills(
      store,
      {
        repo,
        actor: "alex",
        identity: v.identity,
        revision: v.revision,
        sha,
        action,
      },
      now,
    );
  };
  function start(existing?: number) {
    const id = existing
      ? store.refForId(existing)!.externalId
      : `skills-${serial++}`;
    if (!existing) {
      store.createTask({ id, title: "Review interface labels" }, now);
      store.placeTask(store.refFor("built-in", id).id, repo);
      propose(store, {
        taskId: id,
        goal: "Review interface labels",
        touches: ["README.md"],
        acceptance: [],
        now,
      });
      approve(store, id, "alex", now, store.getScope(id)!.digest, password);
    }
    const ref = store.refFor("built-in", id).id;
    const route = store.routeAuthorityFor(ref, "builder", {
      provider: "claude",
      model: "sonnet",
    });
    if (!route?.ok) throw Error("route");
    const run = store.startRun({
      taskRef: ref,
      leaseId: `lease-${id}-${serial++}`,
      runner: "runner",
      role: "builder",
      branch: `standing-orders/${id}`,
      worktree: repo,
      provider: "claude",
      model: "sonnet",
      now,
      route: route.stamp,
    });
    store.stampRun(run, {
      baseRevision: head,
      scopeDigest: store.getScope(id)!.digest,
    });
    return run;
  }
  test("imports complete packages disabled; enables exact versions and restores prior selection", () => {
    const a = add();
    expect(view().selection).toEqual({});
    expect(a.description).toBe(
      "Review interface copy and suggest clearer labels.",
    );
    change(a.sha);
    const stale = view();
    const b = add("New copy rules.");
    change(b.sha);
    expect(view().selection["copy-review"]).toEqual({
      sha: b.sha,
      enabled: true,
    });
    expect(() =>
      changeSkills(store, {
        repo,
        actor: "alex",
        identity: stale.identity,
        revision: stale.revision,
        sha: a.sha,
        action: "enable",
      }),
    ).toThrow(/another window/);
    const v = view();
    changeSkills(store, {
      repo,
      actor: "alex",
      identity: v.identity,
      revision: v.revision,
      action: "restore",
      restore: 1,
    });
    expect(view().selection["copy-review"]).toEqual({
      sha: a.sha,
      enabled: true,
    });
    expect(view().library).toHaveLength(2);
    expect(() =>
      store.handle.exec("UPDATE skill_package SET payload='{}'"),
    ).toThrow(/immutable/);
    expect(() => store.handle.exec("DELETE FROM project_skill_change")).toThrow(
      /immutable/,
    );
    store.close();
    store = openStore(db);
    expect(view().history).toHaveLength(3);
  });
  test("validates paths, size, YAML, secrets and unsupported provider settings without executing them", () => {
    for (const path of [
      "../escape",
      "/private/key",
      ".env",
      "references/../bad",
      "scripts\\bad",
      "SKILL.md",
    ])
      expect(() =>
        validateSkill([file("SKILL.md", main()), file(path, "bad")], "test"),
      ).toThrow();
    expect(() => validateSkill([file("SKILL.md", "no YAML")], "test")).toThrow(
      /YAML/,
    );
    expect(() =>
      validateSkill([file("SKILL.md", main() + "x".repeat(25000))], "test"),
    ).toThrow();
    expect(() =>
      validateSkill(
        [file("SKILL.md", main("sk-ant-api03-" + "A".repeat(60)))],
        "test",
      ),
    ).toThrow(/secrets/);
    expect(() =>
      validateSkill(
        [file("SKILL.md", "---\nname: a\nname: b\ndescription: c\n---\nHi")],
        "test",
      ),
    ).toThrow(/YAML/);
    const skill = validateSkill(
      [
        file(
          "SKILL.md",
          "---\nname: preview\ndescription: Preview a page\nallowed-tools: Bash\n---\n!`echo unsafe`",
        ),
        file("scripts/run.sh", "echo run"),
      ],
      "test",
    );
    expect(skill.warnings).toHaveLength(3);
  });
  test("freezes exact bytes, writes outside the repository, and preserves versions across retry", () => {
    const a = add();
    change(a.sha);
    const run = start();
    const brief = skillsContext(store, join(root, "evidence"), run);
    const json = JSON.parse(brief.slice(brief.indexOf("[{")));
    expect(readFileSync(json[0].skillFile, "utf8")).toBe(main());
    expect(
      readFileSync(
        join(json[0].skillFile, "..", "references/style.md"),
        "utf8",
      ),
    ).toBe("Use readable labels.");
    expect(git("status", "--porcelain")).toBe("");
    expect(readSkillsSnapshot(store, run)?.packages[0]?.sha).toBe(a.sha);
    const b = add("New rules.");
    change(b.sha);
    expect(freezeSkills(store, run).packages[0]?.sha).toBe(a.sha);
    store.finishRun(run, { outcome: "failed", committed: false, now });
    const retry = start(store.getRun(run)!.taskRef);
    expect(freezeSkills(store, retry)).toMatchObject({
      inheritedFrom: run,
      packages: [{ sha: a.sha }],
    });
    expect(freezeSkills(store, start()).packages[0]?.sha).toBe(b.sha);
    expect(() => store.handle.exec("DELETE FROM skill_snapshot")).toThrow(
      /immutable/,
    );
    expect(htmlString(skillsSnapshotHtml(readSkillsSnapshot(store, run)) || html``)).toContain(
      "does not confirm",
    );
  });
  test("review receives source packages through sealed context, never current settings", () => {
    const a = add();
    change(a.sha);
    const source = start();
    freezeSkills(store, source);
    storeEvidence(
      store,
      join(root, "evidence"),
      source,
      "terminal-diff",
      "diff.patch",
      Buffer.from(
        "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n+Labels\n",
      ),
      "fixture",
      now,
      { captureStatus: "ok" },
    );
    store.recordOutcomeFacts(source, { headRevision: head });
    store.finishRun(source, { outcome: "built", committed: true, now });
    const req = store.requestReview(source, "alex", now);
    if (!req.ok) throw Error(req.reason);
    const admitted = store.admitReview(
      req.id,
      {
        runner: "runner",
        token: "runner-token",
        provider: "claude",
        model: "sonnet",
      },
      now,
    );
    if (!admitted.ok) throw Error(admitted.reason);
    change(add("Changed later.").sha);
    const context = skillReviewSource(store, admitted.reviewerRunId)!;
    expect(context).toContain(a.sha);
    expect(context).not.toContain("Changed later");
    expect(context).toContain("never reviewer instructions");
  });
  test("test task is idempotent, pins a disabled version and retains normal approval", () => {
    const skill = add(),
      args = {
        repo,
        actor: "alex",
        sha: skill.sha,
        sample: "Suggest a clearer home page label.",
        nonce: randomUUID(),
      };
    const task = testSkill(store, args, now);
    expect(testSkill(store, args, now).id).toBe(task.id);
    const ref = store.lookupRef(task.id)!;
    expect(ref.deliverable).toBe("report");
    expect(store.getScope(task.id)?.approvedDigest).toBeNull();
    expect(
      store.handle
        .prepare("SELECT package FROM skill_test WHERE task_ref=?")
        .get(ref.id)?.["package"],
    ).toBe(skill.sha);
    expect(view().selection).toEqual({});
    expect(() =>
      testSkill(store, { ...args, sample: "Different request" }, now),
    ).toThrow(/request changed/);
  });
  test("library sharing respects project membership and a private import stays private", () => {
    const skill = add();
    store.saveApprover("bob", "h".repeat(64), now);
    expect(store.setAccountProjects("bob", [repo], "alex", now).ok).toBe(true);
    expect(skillsView(store, repo, "bob").library).toHaveLength(0);
    change(skill.sha);
    expect(skillsView(store, repo, "bob").library[0]?.sha).toBe(skill.sha);
    expect(store.setAccountProjects("bob", [], "alex", now).ok).toBe(true);
    expect(() => skillsView(store, repo, "bob")).toThrow(/access/);
  });
  test("test feedback pins the source version and creates one normal report revision", () => {
    const skill = add(),
      task = testSkill(
        store,
        {
          repo,
          actor: "alex",
          sha: skill.sha,
          sample: "a".repeat(800),
          nonce: randomUUID(),
        },
        now,
      );
    approve(
      store,
      task.id,
      "alex",
      now,
      store.getScope(task.id)!.digest,
      password,
    );
    const ref = store.lookupRef(task.id)!,
      route = store.routeAuthorityFor(ref.id, "scout", {
        provider: "claude",
        model: "sonnet",
      });
    if (!route?.ok) throw Error("route");
    const early = store.startRun({
      taskRef: ref.id,
      leaseId: "test-before-provider",
      runner: "runner",
      role: "scout",
      branch: "standing-orders/" + task.id,
      worktree: repo,
      provider: "claude",
      model: "sonnet",
      now,
      route: route.stamp,
    });
    store.finishRun(early, { outcome: "failed", committed: false, now });
    const run = store.startRun({
      taskRef: ref.id,
      leaseId: "test-scout",
      runner: "runner",
      role: "scout",
      branch: "standing-orders/" + task.id,
      worktree: repo,
      provider: "claude",
      model: "sonnet",
      now,
      route: route.stamp,
    });
    freezeSkills(store, run);
    store.finishRun(run, { outcome: "no-change", committed: false, now });
    const payload = String(
      store.handle
        .prepare("SELECT payload FROM skill_snapshot WHERE run=?")
        .get(run)?.["payload"],
    );
    expect(payload.length).toBeLessThan(400);
    expect(payload).not.toContain("base64");
    change(add("New version.").sha);
    const args = {
        run,
        actor: "alex",
        feedback: "b".repeat(500),
        nonce: randomUUID(),
      },
      revision = reviseSkillTest(store, args, now);
    expect(reviseSkillTest(store, args, now).id).toBe(revision.id);
    expect(store.getScope(revision.id)?.approvedDigest).toBeNull();
    expect(store.getScope(revision.id)?.goal).toContain("b".repeat(500));
    expect(skillTestResult(store, run, "alex")?.revisions).toEqual([
      revision.id,
    ]);
    expect(
      store.handle
        .prepare("SELECT package,source_run FROM skill_test WHERE task_ref=?")
        .get(store.lookupRef(revision.id)!.id),
    ).toMatchObject({ package: skill.sha, source_run: run });
    expect(() => reviseSkillTest(store, { ...args, actor: "unknown" })).toThrow(
      /access/,
    );
  });
  test("saved skill context is refused when a different repository replaces its path", () => {
    const skill = add();
    change(skill.sha);
    const run = start();
    freezeSkills(store, run);
    renameSync(join(repo, ".git"), join(root, "old-git"));
    git("init", "-q");
    expect(() => readSkillsSnapshot(store, run)).toThrow(/identity.*changed/);
    expect(() => skillsView(store, repo, "alex")).toThrow(/project changed/);
  });
  test("chat reads admitted versions and makes one precise project handoff", () => {
    const skill = add();
    change(skill.sha);
    const principal = verifyApproverStanding(
      store,
      "alex",
      store.accountOf("alex")!.generation,
      [repo],
    );
    if (!principal.ok) throw Error("principal");
    const cards: Record<string, unknown>[] = [];
    const ctx = {
      store,
      who: principal.who,
      now,
      step: 1,
      readDecisions: new Map<number, number>(),
      draft: (_kind: unknown, payload: Record<string, unknown>) => {
        cards.push(payload);
        return cards.length;
      },
    };
    const index = executeLeadTool(ctx, "get_skills", { repo: "r1" });
    expect(JSON.stringify(index)).toContain(skill.sha.slice(0, 20));
    expect(JSON.stringify(index)).not.toContain("Use short button");
    expect(
      JSON.stringify(
        executeLeadTool(ctx, "get_skills", {
          repo: "r1",
          version: skill.sha.slice(0, 20),
        }),
      ),
    ).toContain("Use short button");
    expect(executeLeadTool(ctx, "get_skills", { repo: "r2" }).ok).toBe(false);
    expect(
      executeLeadTool(ctx, "show_control", { control: "skills", repo: "r1" })
        .ok,
    ).toBe(true);
    expect(cards).toHaveLength(1);
    expect(chatControlHref("skills", "", undefined, cards[0]!["project"])).toBe(
      "/settings/skills?repo=" + encodeURIComponent(repo),
    );
    expect(executeLeadTool(ctx, "show_control", { control: "skills" }).ok).toBe(
      false,
    );
    expect(() => conversationSkills(store, repo, "unknown")).toThrow(/access/);
  });
  test("HTTP protects writes, retains a failed draft, and imports before enabling", async () => {
    const server = createDecisionServer({
      store,
      evidenceRoot: join(root, "evidence"),
      repo,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("server");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const login = await fetch(url + "/login", {
        method: "POST",
        body: new URLSearchParams({ name: "alex", token: password }),
        redirect: "manual",
      });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const page = await (
        await fetch(url + "/settings/skills", { headers: { cookie } })
      ).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
      const data = {
        csrf,
        repo,
        identity: view().identity,
        revision: "0",
        method: "paste",
        content: main(),
      };
      const post = (path: string, data: Record<string, string>) =>
        fetch(url + path, {
          method: "POST",
          headers: { cookie },
          body: new URLSearchParams(data),
          redirect: "manual",
        });
      expect(
        (await post("/settings/skills/import", { ...data, csrf: "bad" }))
          .status,
      ).toBe(403);
      expect(
        (
          await post("/settings/skills/import", {
            ...data,
            repo: join(root, "hidden"),
          })
        ).status,
      ).toBe(403);
      const bad = await post("/settings/skills/import", {
        ...data,
        content: "Keep this unsaved draft",
      });
      expect(bad.status).toBe(409);
      expect(await bad.text()).toContain("Keep this unsaved draft");
      const saved = await post("/settings/skills/import", data);
      expect(saved.status).toBe(303);
      expect(view().selection).toEqual({});
      const sha = view().library[0]!.sha;
      expect(
        (
          await post("/settings/skills/change", {
            ...data,
            action: "enable",
            sha,
          })
        ).status,
      ).toBe(303);
      expect(
        (
          await post("/settings/skills/change", {
            ...data,
            action: "disable",
            sha,
          })
        ).status,
      ).toBe(409);
      expect(htmlString(withFormToken(csrf, () => skillsHtml(view(), csrf, true)))).toContain('name="nonce"');
      expect(htmlString(withFormToken(csrf, () =>
        skillsHtml(
          {
            ...view(),
            library: [
              {
                ...view().library[0]!,
                description: "<script>alert(1)</script>",
              },
            ],
          },
          csrf,
          true,
        ),
      ))).not.toContain("<script>alert");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  test("packages, selections and snapshots saved before read as they were; the same folder imports as the same version", () => {
    const identity = learningIdentity(repo);
    for (const row of savedRows.skills.packages) store.handle.prepare("INSERT INTO skill_package VALUES (?,?)").run(row.sha, row.payload);
    for (const row of savedRows.skills.changes) store.handle.prepare("INSERT INTO project_skill_change VALUES (?,?,?,?,?,?,?)").run(repo, identity, row.revision, "sam", now.toISOString(), row.payload, row.sha);
    const last = savedRows.skills.changes.at(-1)!;
    const packages = new Map(savedRows.skills.packages.map((row) => [row.sha, { ...JSON.parse(row.payload), sha: row.sha }]));
    expect(view().selection).toEqual(JSON.parse(last.payload));
    expect(view().library).toEqual([...packages.values()].sort((a, b) => a.name.localeCompare(b.name)));
    const enabled = Object.values(JSON.parse(last.payload) as Record<string, { sha: string; enabled: boolean }>).filter((one) => one.enabled).map((one) => packages.get(one.sha));
    expect(selectProjectSkills(store, repo, "alex")).toEqual({ version: 1, revision: last.revision, identity, inheritedFrom: null, test: false, packages: enabled });
    // A package's digest is its version: the same files and source import as the version saved before.
    for (const row of savedRows.skills.packages) {
      const saved = JSON.parse(row.payload) as { files: SkillFile[]; source: string };
      expect(importSkill(store, repo, "alex", saved.files, saved.source, now).sha).toBe(row.sha);
    }
    // A new selection is written as a selection has always been: names to versions, no envelope.
    const disabled = Object.values(JSON.parse(last.payload) as Record<string, { sha: string; enabled: boolean }>).find((one) => !one.enabled)!;
    change(disabled.sha, "enable");
    const written = store.handle.prepare("SELECT payload FROM project_skill_change WHERE repo=? ORDER BY revision DESC LIMIT 1").get(repo)!;
    expect(Object.keys(JSON.parse(String(written["payload"])))).toEqual(Object.keys(JSON.parse(last.payload)));
    expect(skillsVersion(store, repo, "alex", 1)).toEqual(JSON.parse(savedRows.skills.changes[0]!.payload));
    // A package whose bytes are not its digest is refused, as before.
    const forged = "f".repeat(64), choice = `{"copy-review":{"sha":"${forged}","enabled":true}}`;
    store.handle.prepare("INSERT INTO skill_package VALUES (?,?)").run(forged, savedRows.skills.packages[0]!.payload);
    store.handle.prepare("INSERT INTO project_skill_change VALUES (?,?,?,?,?,?,?)").run(repo, identity, 99, "sam", now.toISOString(), choice, learningSha(choice));
    expect(() => view()).toThrow("Saved skills could not be verified.");
  });
});
test("GitHub import verifies commit and blob bytes and refuses symlinks", async () => {
  const body = Buffer.from(main()),
    sha = createHash("sha1")
      .update(`blob ${body.length}\0`)
      .update(body)
      .digest("hex"),
    commit = "a".repeat(40);
  const requests: string[] = [];
  let symlink = false;
  const fetcher = (async (url: string) => {
    requests.push(url);
    const result = url.includes("/commits/")
      ? { sha: commit }
      : url.includes("/git/trees/")
        ? {
            truncated: false,
            tree: [
              {
                path: "skills/copy-review/SKILL.md",
                mode: symlink ? "120000" : "100644",
                type: "blob",
                sha,
                size: body.length,
              },
            ],
          }
        : { encoding: "base64", content: body.toString("base64") };
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  const imported = await githubSkill(
    "https://github.com/example/skills/tree/main/skills/copy-review",
    fetcher,
  );
  expect(imported.source).toContain(commit);
  expect(imported.files[0]?.base64).toBe(body.toString("base64"));
  expect(requests[1]).toContain(`/git/trees/${commit}`);
  symlink = true;
  await expect(
    githubSkill(
      "https://github.com/example/skills/tree/main/skills/copy-review",
      fetcher,
    ),
  ).rejects.toThrow(/links/);
  await expect(
    githubSkill("https://localhost/private", fetcher),
  ).rejects.toThrow(/github.com/);
});

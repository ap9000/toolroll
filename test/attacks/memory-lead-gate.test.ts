/**
 * Project memory's writes are a person's act. `memory decide`, `memory retire` and `memory apply` (and the library writers
 * they reach: recordDecision, retireDecision, decideProposal) record what every later build on the project reads, so,
 * like `knowledge apply`, they take a person's own proof and never the lead's token or the lead's chain. Reads keep
 * working as they did. Every road into the same writes is covered: the CLI (a lead token by flag or environment, the
 * lead's own chain), a remote API token, the easy-start local owner, Passwordless, the console's routes and the lead's
 * chat tools (which only ever propose).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { marker } from "./harness.js";
import { runOperate, runOperateAs, writeLoginFileDurably, type Principal } from "../../src/operate.js";
import { withActor } from "../../src/actor.js";
import { addApprover } from "../../src/scope.js";
import { initLocalMode, openStore, type Store } from "../../src/store.js";
import { mintApiToken } from "../../src/api-tokens.js";
import { runAsLocalOwner } from "../../src/local-owner.js";
import { setPasswordless } from "../../src/passwordless.js";
import { listDecisions, recordDecision, retireDecision } from "../../src/project-memory.js";
import { decideProposal, listProposals, memorySurface } from "../../src/memory-pass.js";
import { COMMAND_GUIDE, REMOTE_POLICY } from "../../src/surface.js";
import { withRemote } from "../../src/remote-run.js";
import { ROUTES } from "../../src/server/route-table.js";
import { CHAT_ACTION_LOCAL_ACTS } from "../../src/local-owner.js";
import { savedLoginFile } from "../../src/login-secrets.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");
let root: string, repo: string, db: string, password: string, leadToken: string;
const withStore = <T>(fn: (store: Store) => T): T => { const store = openStore(db); try { return fn(store); } finally { store.close(); } };
const withStoreAsync = async <T>(fn: (store: Store) => Promise<T>): Promise<T> => { const store = openStore(db); try { return await fn(store); } finally { store.close(); } };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "so-memory-gate-")));
  repo = join(root, "repo");
  db = join(root, "state.db");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  git("init", "-q");
  writeFileSync(join(repo, "README.md"), "memory gate\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "seed");
  withStore(store => {
    const alex = addApprover(store, "alex", NOW);
    if (!alex.ok) throw Error("fixture");
    password = alex.token;
    // A task places the project, so the memory commands know it.
    store.createTask({ id: "seed", title: "seed" }, NOW);
    store.placeTask(store.refFor("built-in", "seed").id, repo);
    leadToken = store.mintLeadCredential("alex", "alex", NOW).token;
    recordDecision(store, { repo, actor: "alex", draft: { claim: "Ship from main only.", why: "One branch to reason about.", sourceKind: "manual" } }, NOW);
  });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); delete process.env["TOOLROLL_LEAD_TOKEN"]; });

/** A pending backward-pass proposal against the current memory surface. */
function pendingProposal(claim: string): number {
  return withStore(store => {
    const surface = memorySurface(store, repo, "alex");
    const made = store.handle.prepare("INSERT INTO memory_proposal(repo,kind,fingerprint,title,rationale,before_text,after_text,evidence,sessions,status,created_at,surface) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(repo, "decision-add", `decision-add:${claim}`, claim, "Seen in two sessions.", null, claim, "[]", 2, "pending", NOW.toISOString(), surface.version);
    return Number(made.lastInsertRowid);
  });
}

async function cli(args: string[]): Promise<{ code: number; envelope: Record<string, unknown> }> {
  let out = "";
  const code = await runOperate("memory", [...args, "--json", "--db", db], text => { out += text; }, { now: NOW });
  return { code, envelope: JSON.parse(out.trim() || "{}") as Record<string, unknown> };
}
const claims = () => withStore(store => listDecisions(store, repo, "alex", { status: "all" }).map(one => `${one.claim}:${one.status}`));
const proposalStatus = (id: number) => withStore(store => listProposals(store, repo, "all").find(one => one.id === id)?.status);

/** Each mutating memory verb, with the argv that would change memory. */
const WRITES: Record<string, (ids: { decision: number; proposal: number }) => string[]> = {
  decide: () => ["decide", marker("claim"), "--why", "because", "--repo", repo],
  retire: ids => ["retire", String(ids.decision), "--reason", "no longer holds", "--repo", repo],
  apply: ids => ["apply", String(ids.proposal), "--decision", "accept", "--repo", repo],
};
const ids = () => ({ decision: withStore(store => listDecisions(store, repo, "alex")[0]!.id), proposal: pendingProposal(marker("proposal")) });

describe("the lead never writes project memory", () => {
  test("a lead token on the command line is refused for every write, and nothing changes", async () => {
    for (const [verb, argv] of Object.entries(WRITES)) {
      const before = claims(), at = ids();
      for (const extra of [["--token", leadToken], ["--as", "alex", "--token", leadToken]]) {
        const { code, envelope } = await cli([...argv(at), ...extra]);
        expect(code, `${verb} ${extra.join(" ")}`).not.toBe(0);
        expect(envelope["ok"]).toBe(false);
      }
      expect(claims(), verb).toEqual(before);
      expect(proposalStatus(at.proposal)).toBe("pending");
    }
  });

  test("the lead's token in the environment proves nothing for a memory write", async () => {
    process.env["TOOLROLL_LEAD_TOKEN"] = leadToken;
    for (const [verb, argv] of Object.entries(WRITES)) {
      const before = claims(), at = ids();
      const { code, envelope } = await cli(argv(at));
      expect(code, verb).not.toBe(0);
      expect(envelope).toMatchObject({ ok: false, reason: "unauthenticated" });
      expect(claims(), verb).toEqual(before);
      expect(proposalStatus(at.proposal)).toBe("pending");
    }
  });

  test("inside the lead's own chain, even its owner's password does not make a memory write the lead's to do", async () => {
    for (const [verb, argv] of Object.entries(WRITES)) {
      const before = claims(), at = ids();
      const { code, envelope } = await withActor({ account: "alex", lead: true }, () => cli([...argv(at), "--as", "alex", "--token", password]));
      expect(code, verb).not.toBe(0);
      expect(envelope, verb).toMatchObject({ ok: false, reason: "unauthenticated" });
      expect(String(envelope["message"]), verb).toMatch(/person/);
      expect(claims(), verb).toEqual(before);
      expect(proposalStatus(at.proposal), verb).toBe("pending");
    }
    // Reads keep working there, as they always did.
    const read = await withActor({ account: "alex", lead: true }, () => cli(["decisions", "--repo", repo, "--as", "alex", "--token", password]));
    expect(read.code).toBe(0);
    expect(JSON.stringify(read.envelope)).toContain("Ship from main only.");
  });

  test("the library writers refuse the lead's chain too (the CLI is not the only caller)", () => {
    const at = ids();
    withStore(store => {
      const decision = listDecisions(store, repo, "alex")[0]!.id;
      withActor({ account: "alex", lead: true }, () => {
        expect(() => recordDecision(store, { repo, actor: "alex", draft: { claim: "Lead says so.", why: "It wanted to.", sourceKind: "manual" } }, NOW)).toThrow(/person, not the lead/);
        expect(() => retireDecision(store, { repo, actor: "alex", id: decision, reason: "Lead says so." }, NOW)).toThrow(/person, not the lead/);
        expect(() => decideProposal(store, { repo, actor: "alex", id: at.proposal, decision: "accept" }, NOW)).toThrow(/person, not the lead/);
        expect(() => decideProposal(store, { repo, actor: "alex", id: at.proposal, decision: "reject" }, NOW)).toThrow(/person, not the lead/);
      });
    });
    expect(claims()).toEqual(["Ship from main only.:active"]);
    expect(proposalStatus(at.proposal)).toBe("pending");
  });

  test("the lead's chat tools only propose memory: the cards are a person's to confirm, never the local owner's", () => {
    expect(CHAT_ACTION_LOCAL_ACTS.decision_record).toBeNull();
    expect(CHAT_ACTION_LOCAL_ACTS.decision_retire).toBeNull();
  });
});

describe("the other roads into the same writes", () => {
  test("a remote API token: every memory write is a step-up it never passes, and the writers refuse a remote run", async () => {
    for (const verb of ["decide", "retire", "apply"]) expect(REMOTE_POLICY.get(`memory ${verb}`), verb).toBe("step-up");
    expect(REMOTE_POLICY.get("memory propose")).toBe("no");
    for (const verb of ["search", "decisions", "show", "review", "status"]) expect(REMOTE_POLICY.get(`memory ${verb}`), verb).toBe("yes");
    // The command guide no longer offers the writes to agents; the reads stay theirs.
    for (const verb of ["decide", "retire", "apply"]) expect(COMMAND_GUIDE.find(row => row.invocation === `memory ${verb}`)?.agentMayInvoke, verb).toBe(false);
    expect(COMMAND_GUIDE.find(row => row.invocation === "memory search")?.agentMayInvoke).toBe(true);
    const minted = mintApiToken();
    const at = ids();
    const principal = withStore(store => {
      store.createApiToken({ id: minted.id, account: "alex", name: "script", secretHash: minted.hash, access: "act", expiresAt: "2027-06-01T00:00:00.000Z", by: "alex" }, NOW);
      return { kind: "person", account: "alex", generation: store.accountOf("alex")!.generation, scope: "act", tokenId: minted.id, projects: null } satisfies Principal;
    });
    const before = claims();
    for (const [verb, argv] of Object.entries(WRITES)) {
      let out = "";
      const code = await withStoreAsync(store => runOperateAs(["memory", ...argv(at), "--json"], { principal, store, write: line => { out += line; }, options: { now: NOW } }));
      expect(code, verb).not.toBe(0);
      expect(JSON.parse(out), verb).toMatchObject({ ok: false, reason: "step-up" });
    }
    expect(claims()).toEqual(before);
    expect(proposalStatus(at.proposal)).toBe("pending");
    // Reads still run remotely.
    let read = "";
    expect(await withStoreAsync(store => runOperateAs(["memory", "decisions", "--repo", repo, "--json"], { principal, store, write: line => { read += line; }, options: { now: NOW } }))).toBe(0);
    expect(read).toContain("Ship from main only.");
    // A writer reached inside a remote run (any future road) refuses too.
    const run = { account: "alex", scope: "act", tokenName: "script", source: "api", secret: "s", allows: () => true, lens: null, noteTask: () => {}, files: {} } as unknown as Parameters<typeof withRemote>[0];
    withStore(store => withRemote(run, () => {
      expect(() => recordDecision(store, { repo, actor: "alex", draft: { claim: "Token says so.", why: "x", sourceKind: "manual" } }, NOW)).toThrow(/not an API token/);
      expect(() => decideProposal(store, { repo, actor: "alex", id: at.proposal, decision: "reject" }, NOW)).toThrow(/not an API token/);
    }));
    expect(proposalStatus(at.proposal)).toBe("pending");
  });

  test("the easy-start local owner: memory is not one of its acts, so every memory command is refused before it runs", async () => {
    const laptop = join(root, "laptop.db");
    const store = openStore(laptop, { createdBy: "laptop" });
    try { if (!initLocalMode(store, { owner: "lee", fenceAvailable: true, now: NOW }).ok) throw Error("local mode"); } finally { store.close(); }
    for (const argv of [["decide", "x", "--why", "y", "--repo", repo], ["retire", "1", "--reason", "r", "--repo", repo], ["apply", "1", "--decision", "accept", "--repo", repo], ["decisions", "--repo", repo]]) {
      let out = "";
      const code = await runAsLocalOwner(() => runOperate("memory", [...argv, "--json", "--db", laptop], text => { out += text; }, { now: NOW }));
      expect(code, argv[0]).not.toBe(0);
      expect(JSON.parse(out), argv[0]).toMatchObject({ ok: false, reason: "refused" });
    }
  });

  test("the console's memory routes take a browser sign-in as an approver: no token, no lead, no local owner", () => {
    for (const id of ["settings.knowledge-proposal", "settings.knowledge-decision"]) {
      const route = ROUTES.find(one => one.id === id)!;
      expect(route, id).toBeDefined();
      expect(route.callers, id).not.toContain("lead");
      expect(route.role, id).toBe("approver");
      expect(route.roleBrowser, id).toBe(true);
      expect(route.local, id).toBe("deny");
    }
  });
});

describe("standing is read at the write", () => {
  test("a revoked person's password, and the writers for them, change nothing", async () => {
    const sam = withStore(store => { const made = addApprover(store, "sam", NOW, { name: "alex", token: password }); if (!made.ok) throw Error("fixture"); return made.token; });
    const at = ids();
    withStore(store => { store.handle.prepare("UPDATE approver SET revoked_at = ? WHERE name = 'sam'").run(NOW.toISOString()); });
    const before = claims();
    for (const [verb, argv] of Object.entries(WRITES)) expect((await cli([...argv(at), "--as", "sam", "--token", sam])).code, verb).not.toBe(0);
    withStore(store => {
      expect(() => recordDecision(store, { repo, actor: "sam", draft: { claim: "Revoked says so.", why: "x", sourceKind: "manual" } }, NOW)).toThrow(/outside your access/);
      expect(() => decideProposal(store, { repo, actor: "sam", id: at.proposal, decision: "reject" }, NOW)).toThrow(/outside your access/);
    });
    expect(claims()).toEqual(before);
    expect(proposalStatus(at.proposal)).toBe("pending");
  });

  test("the lead's chain may not file proposals either (memory propose)", async () => {
    const { code, envelope } = await withActor({ account: "alex", lead: true }, () => cli(["propose", "--repo", repo, "--no-local", "--as", "alex", "--token", password]));
    expect(code).not.toBe(0);
    expect(envelope).toMatchObject({ ok: false, reason: "unauthenticated" });
  });
});

describe("a person still writes memory", () => {
  test("with their password: decide, retire and apply all work, and reads too", async () => {
    const at = ids();
    // Apply first: a proposal is made against memory as it stands, and any later change makes it stale.
    expect((await cli([...WRITES["apply"]!(at), "--as", "alex", "--token", password])).code).toBe(0);
    expect(proposalStatus(at.proposal)).toBe("accepted");
    expect((await cli(["decide", "Review every release.", "--why", "Early adopters.", "--repo", repo, "--as", "alex", "--token", password])).code).toBe(0);
    expect((await cli([...WRITES["retire"]!(at), "--as", "alex", "--token", password])).code).toBe(0);
    expect((await cli(["search", "release", "--repo", repo, "--as", "alex", "--token", password])).code).toBe(0);
  });

  test("with Passwordless on, the remembered login at this computer stays the person's proof (unchanged)", async () => {
    withStore(store => { setPasswordless(store, true, "alex", NOW); });
    const login = savedLoginFile(root);
    mkdirSync(dirname(login), { recursive: true, mode: 0o700 });
    writeLoginFileDurably(login, "alex", password);
    const { code } = await cli(["decide", "Keep the login remembered.", "--why", "Passwordless.", "--repo", repo]);
    expect(code).toBe(0);
    // ...but not inside the lead's chain, whatever login is remembered.
    const lead = await withActor({ account: "alex", lead: true }, () => cli(["decide", "Lead via remembered login.", "--why", "x", "--repo", repo]));
    expect(lead.code).not.toBe(0);
    expect(claims().some(one => one.startsWith("Lead via"))).toBe(false);
  });
});

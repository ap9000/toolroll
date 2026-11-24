import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  agentRequestsPath,
  clearResolvedAgentRequests,
  fileAgentRequest,
  listAgentRequests,
  resolveAgentRequest,
} from "./agent-requests.js";
import { runOperate } from "./operate.js";
import { openStore } from "./store.js";

describe("agent-requests", () => {
  test("files, deduplicates, resolves, and clears requests inside .toolroll-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "tr-agent-req-"));
    const db = join(dir, "orders.db");

    expect(agentRequestsPath(db)).toBe(join(dir, ".toolroll-run", "agent-requests.json"));

    const r1 = fileAgentRequest(db, {
      kind: "network",
      repo: "/tmp/demo-site",
      requester: "Claude Code",
      summary: "Allow this Mac's local services (localhost / ::1)",
      why: "Vite prerendering binds ::1:3000",
      params: { local: "any", mode: "allowlist", hosts: [] },
    });
    expect(r1.status).toBe("pending");
    expect(r1.projectName).toBe("demo-site");

    const r2 = fileAgentRequest(db, {
      kind: "network",
      repo: "/tmp/demo-site",
      requester: "Codex",
      summary: "Allow this Mac's local services (localhost / ::1)",
      why: "Updated reason",
      params: { local: "any", mode: "allowlist", hosts: [] },
    });
    expect(r2.id).toBe(r1.id);
    expect(r2.why).toBe("Updated reason");
    expect(listAgentRequests(db, { status: "pending" })).toHaveLength(1);

    const resolved = resolveAgentRequest(db, r1.id, "approved", "Applied via Touch ID");
    expect(resolved?.status).toBe("approved");
    expect(listAgentRequests(db, { status: "pending" })).toHaveLength(0);
    expect(listAgentRequests(db)).toHaveLength(1);

    expect(clearResolvedAgentRequests(db)).toBe(1);
    expect(listAgentRequests(db)).toHaveLength(0);
  });

  test("CLI --request files network, setup, and live-view requests without mutating settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tr-agent-req-cli-"));
    const db = join(dir, "orders.db");
    const repo = join(dir, "site");
    const store = openStore(db);
    store.upsertProject(repo, "site", new Date("2026-11-22T00:00:00Z"));
    store.close();

    const run = async (command: string, argv: string[]) => {
      const out: string[] = [];
      const code = await runOperate(command, [...argv, "--json"], line => out.push(line), { databaseFile: db });
      return { code, body: JSON.parse(out.join("\n")) as Record<string, unknown> };
    };

    const net = await run("project", ["network", "--repo", repo, "--local", "any", "--request", "Vite needs localhost", "--by", "Claude Code"]);
    expect(net.code).toBe(0);
    expect(net.body["ok"]).toBe(true);
    expect((net.body["request"] as Record<string, unknown>)["kind"]).toBe("network");

    const setup = await run("setup", ["set", "--repo", repo, "--command", "npm ci", "--request", "Need node_modules in fresh worktrees"]);
    expect(setup.code).toBe(0);
    expect((setup.body["request"] as Record<string, unknown>)["kind"]).toBe("worktree-setup");

    const live = await run("project", ["live-view", "--repo", repo, "on", "--request", "Debug build output"]);
    expect(live.code).toBe(0);
    expect((live.body["request"] as Record<string, unknown>)["kind"]).toBe("live-view");

    const verifyStore = openStore(db);
    expect(verifyStore.projectNetwork(repo).loopback).toBe("proxy-only");
    expect(verifyStore.liveWorktreeSetup(repo)).toBeNull();
    verifyStore.close();

    const listed = await run("request", ["list"]);
    expect(listed.code).toBe(0);
    expect((listed.body["requests"] as unknown[]).length).toBe(3);

    const firstId = ((listed.body["requests"] as Array<{ id: string }>)[0]!).id;
    const declined = await run("request", ["decline", firstId, "--note", "Not needed"]);
    expect(declined.code).toBe(0);
    expect((declined.body["request"] as Record<string, unknown>)["status"]).toBe("declined");

    const cleared = await run("request", ["clear"]);
    expect(cleared.code).toBe(0);
    expect(cleared.body["removed"]).toBe(1);
  });
});

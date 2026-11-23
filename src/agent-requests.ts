/**
 * Pending operator-approval requests filed by host orchestrator agents (Claude Code, Codex, Antigravity).
 *
 * Stored inside `<stateDir>/.toolroll-run/agent-requests.json` (0700 dir, 0600 file), which is already fenced
 * from every sandboxed build agent in agent-fence.ts. Filing a request changes nothing on its own; only a
 * person approving it in Toolroll.app (via Touch ID or password) applies the change through the server's
 * password-checked endpoints and ledger.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type AgentRequestKind = "network" | "worktree-setup" | "live-view";
export type AgentRequestStatus = "pending" | "approved" | "declined";

export type AgentRequestParams = {
  local?: "any" | "proxy-only";
  mode?: "open" | "allowlist";
  hosts?: string[];
  command?: string;
  timeoutSeconds?: number;
  showCommands?: boolean;
};

export type AgentRequest = {
  id: string;
  kind: AgentRequestKind;
  repo: string;
  projectName: string;
  requester: string;
  summary: string;
  why: string;
  params: AgentRequestParams;
  status: AgentRequestStatus;
  createdAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
};

type AgentRequestFile = {
  version: 1;
  requests: AgentRequest[];
};

const MAX_STORED_REQUESTS = 100;

export function agentRequestsPath(databaseFile: string): string {
  return join(dirname(databaseFile), ".toolroll-run", "agent-requests.json");
}

function readRequestFile(filePath: string): AgentRequestFile {
  if (!existsSync(filePath)) return { version: 1, requests: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<AgentRequestFile>;
    if (!parsed || !Array.isArray(parsed.requests)) return { version: 1, requests: [] };
    return { version: 1, requests: parsed.requests };
  } catch {
    return { version: 1, requests: [] };
  }
}

function writeRequestFile(filePath: string, data: AgentRequestFile): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const trimmed: AgentRequestFile = {
    version: 1,
    requests: data.requests.slice(-MAX_STORED_REQUESTS),
  };
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(trimmed, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, filePath);
}

export function listAgentRequests(
  databaseFile: string,
  options: { status?: AgentRequestStatus; repo?: string } = {},
): AgentRequest[] {
  const all = readRequestFile(agentRequestsPath(databaseFile)).requests;
  return all.filter(one => {
    if (options.status !== undefined && one.status !== options.status) return false;
    if (options.repo !== undefined && one.repo !== options.repo) return false;
    return true;
  });
}

export function fileAgentRequest(
  databaseFile: string,
  input: {
    kind: AgentRequestKind;
    repo: string;
    requester?: string;
    summary: string;
    why: string;
    params: AgentRequestParams;
  },
  now: Date = new Date(),
): AgentRequest {
  const filePath = agentRequestsPath(databaseFile);
  const data = readRequestFile(filePath);
  const cleanWhy = input.why.trim().slice(0, 600);
  const cleanRequester = (input.requester ?? process.env["TOOLROLL_AGENT_NAME"] ?? "Agent").trim().slice(0, 80) || "Agent";

  // Deduplicate an identical still-pending request for the same repo + kind + params
  const existing = data.requests.find(
    one =>
      one.status === "pending" &&
      one.kind === input.kind &&
      one.repo === input.repo &&
      JSON.stringify(one.params) === JSON.stringify(input.params),
  );
  if (existing !== undefined) {
    existing.why = cleanWhy || existing.why;
    existing.requester = cleanRequester;
    existing.summary = input.summary;
    writeRequestFile(filePath, data);
    return existing;
  }

  const made: AgentRequest = {
    id: `req_${randomBytes(5).toString("hex")}`,
    kind: input.kind,
    repo: input.repo,
    projectName: basename(input.repo) || input.repo,
    requester: cleanRequester,
    summary: input.summary,
    why: cleanWhy,
    params: input.params,
    status: "pending",
    createdAt: now.toISOString(),
  };
  data.requests.push(made);
  writeRequestFile(filePath, data);
  return made;
}

export function resolveAgentRequest(
  databaseFile: string,
  id: string,
  status: "approved" | "declined",
  note?: string,
  now: Date = new Date(),
): AgentRequest | null {
  const filePath = agentRequestsPath(databaseFile);
  const data = readRequestFile(filePath);
  const found = data.requests.find(one => one.id === id);
  if (found === undefined) return null;
  found.status = status;
  found.resolvedAt = now.toISOString();
  if (note !== undefined && note.trim() !== "") found.resolutionNote = note.trim().slice(0, 400);
  writeRequestFile(filePath, data);
  return found;
}

export function clearResolvedAgentRequests(databaseFile: string): number {
  const filePath = agentRequestsPath(databaseFile);
  const data = readRequestFile(filePath);
  const before = data.requests.length;
  data.requests = data.requests.filter(one => one.status === "pending");
  writeRequestFile(filePath, data);
  return before - data.requests.length;
}

export async function waitForAgentRequest(
  databaseFile: string,
  id: string,
  timeoutSeconds = 300,
): Promise<AgentRequest | null> {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() <= deadline) {
    const current = listAgentRequests(databaseFile).find(one => one.id === id) ?? null;
    if (current === null || current.status !== "pending") return current;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return listAgentRequests(databaseFile).find(one => one.id === id) ?? null;
}

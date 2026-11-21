/** Remote-terminal connection metadata and request admission. Credentials remain people, never local-owner sessions. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import { reproveRemote, type Principal } from "./operate-remote.js";
import { adapterPolicy } from "./server/route-policy.js";
import { engineContractDigest, ENGINE_API_VERSION } from "./contracts/engine-api.js";
import {
  DISABLED_TERMINAL_CAPABILITIES,
  REMOTE_TUI_COMMANDS,
  TERMINAL_CONNECTION_PROTOCOL,
  terminalConnectionSchema,
  type TerminalConnection,
  type TerminalConnectionError,
} from "./contracts/terminal-connection.js";
import { RECOVERY_GENERATION_PATTERN, WORKSPACE_ID_PATTERN } from "./workspace-identity-schema.js";
import type { Admission } from "./request-budget.js";

export type TerminalConnectionOptions = {
  store: Store;
  clock: () => Date;
  authenticate: (request: IncomingMessage) => Principal | null;
  admit?: (principal: Principal) => Admission;
};

/** Console routes admitted for a scoped `terminal-remote` bearer token (in addition to `GET /live` and `POST /api/cli`). */
export const REMOTE_TUI_READ_ROUTES: ReadonlySet<string> = new Set([
  "work.rows",
  "task.steps",
  "task.diff",
  "agents.live.run",
  "engine.chat",
]);

/** Whether the request declares the remote TUI client transport. Never grants authority by itself. */
export function isRemoteTerminalRequest(request: IncomingMessage): boolean {
  return request.headers["x-toolroll-client"] === "terminal-remote";
}

function headerNames(request: IncomingMessage): string[] {
  return request.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
}

function hasForbiddenBrowserHeaders(names: readonly string[]): boolean {
  return names.includes("cookie") || names.includes("origin") || names.includes("referer")
    || names.some(name => name.startsWith("sec-fetch-"));
}

export type RemoteTerminalAdmission =
  | { ok: true; scope: "read" | "act"; identity: ReturnType<Store["workspaceIdentity"]> }
  | { ok: false; status: number; error: TerminalConnectionError };

/**
 * Shared guard for every `terminal-remote` read/stream request after `GET /engine/connection`.
 * Rejects browser headers, duplicate credentials/binding headers, non-API credentials, revoked/expired tokens,
 * and mismatched pinned `x-toolroll-workspace` / `x-toolroll-recovery` headers before any lookup or output.
 */
export function admitRemoteTerminalRequest(
  request: IncomingMessage,
  store: Store,
  principal: Principal | undefined,
  clock: () => Date,
): RemoteTerminalAdmission {
  const names = headerNames(request);
  if (hasForbiddenBrowserHeaders(names)
    || names.filter(name => name === "authorization").length !== 1
    || names.filter(name => name === "x-toolroll-client").length !== 1
    || request.headers["x-toolroll-client"] !== "terminal-remote"
    || names.filter(name => name === "x-toolroll-workspace").length !== 1
    || names.filter(name => name === "x-toolroll-recovery").length !== 1) {
    return { ok: false, status: 400, error: "request" };
  }
  const workspace = request.headers["x-toolroll-workspace"];
  const recovery = request.headers["x-toolroll-recovery"];
  if (typeof workspace !== "string" || !WORKSPACE_ID_PATTERN.test(workspace)
    || typeof recovery !== "string" || !RECOVERY_GENERATION_PATTERN.test(recovery)) {
    return { ok: false, status: 400, error: "request" };
  }
  if (principal === undefined || !/^Bearer so_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/.test(request.headers.authorization ?? "")) {
    return { ok: false, status: 401, error: "unauthenticated" };
  }
  const live = reproveRemote(store, principal, clock());
  if (!live.ok) return { ok: false, status: 401, error: "unauthenticated" };
  const credential = store.apiTokenSecret(principal.tokenId)?.row;
  if (credential?.purpose !== "api") return { ok: false, status: 403, error: "credential-purpose" };
  if (!adapterPolicy({ caller: "bearer", capability: live.scope, token: true }, "read").ok) {
    return { ok: false, status: 403, error: "unauthenticated" };
  }
  let identity: ReturnType<Store["workspaceIdentity"]>;
  try { identity = store.workspaceIdentity(); } catch { return { ok: false, status: 503, error: "workspace-unavailable" }; }
  if (identity.id !== workspace) return { ok: false, status: 409, error: "workspace-mismatch" };
  if (identity.recoveryGeneration !== recovery) return { ok: false, status: 409, error: "recovery-changed" };
  return { ok: true, scope: live.scope, identity };
}

/** Send a strict JSON refusal for a `terminal-remote` request (never an HTML redirect). */
export function sendTerminalConnectionRefusal(request: IncomingMessage, response: ServerResponse, status: number, error: TerminalConnectionError): void {
  request.resume();
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ protocol: TERMINAL_CONNECTION_PROTOCOL, error }));
}

/** Handles only the explicitly registered GET. No credential, cookie, link or grant is created. */
export function handleTerminalConnection(request: IncomingMessage, response: ServerResponse, options: TerminalConnectionOptions): void {
  const send = (status: number, value: unknown): void => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "pragma": "no-cache", "x-content-type-options": "nosniff" });
    response.end(JSON.stringify(value));
  };
  const refuse = (status: number, error: TerminalConnectionError): void => {
    request.resume(); send(status, { protocol: TERMINAL_CONNECTION_PROTOCOL, error });
  };
  const names = headerNames(request);
  if (request.method !== "GET" || request.url !== "/engine/connection" || hasForbiddenBrowserHeaders(names)
    || names.filter(name => name === "authorization").length !== 1
    || names.filter(name => name === "x-toolroll-client").length !== 1 || request.headers["x-toolroll-client"] !== "terminal-remote"
    || request.headers["transfer-encoding"] !== undefined || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) return refuse(400, "request");
  if (!/^Bearer so_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/.test(request.headers.authorization ?? "")) return refuse(401, "unauthenticated");
  let principal: Principal | null;
  try { principal = options.authenticate(request); } catch { return refuse(503, "contract-unavailable"); }
  if (principal === null) return refuse(401, "unauthenticated");
  const store = options.store;
  try {
    const before = reproveRemote(store, principal, options.clock());
    if (!before.ok) return refuse(401, "unauthenticated");
    const credential = store.apiTokenSecret(principal.tokenId)?.row;
    if (credential?.purpose !== "api") return refuse(403, "credential-purpose");
    if (!adapterPolicy({ caller: "bearer", capability: before.scope, token: true }, "read").ok) return refuse(403, "unauthenticated");
    const budget = options.admit?.(principal);
    if (budget !== undefined && !budget.ok) {
      if (budget.status !== 503) response.setHeader("retry-after", String(budget.retryAfter));
      return refuse(budget.status === 503 ? 503 : 429, "request");
    }
    let identity: ReturnType<Store["workspaceIdentity"]>;
    try { identity = store.workspaceIdentity(); } catch { return refuse(503, "workspace-unavailable"); }
    const account = store.accountOf(principal.account);
    if (account === null) return refuse(401, "unauthenticated");
    const capabilities: TerminalConnection["capabilities"] = {
      ...DISABLED_TERMINAL_CAPABILITIES,
      workRows: true,
      stepCards: true,
      resultDiff: true,
      runLiveWindow: true,
      leadChat: account.role === "approver",
      liveStream: true,
      localCode: true,
      commands: before.scope === "act" && account.role === "approver" ? [...REMOTE_TUI_COMMANDS] : [],
    };
    const candidate: TerminalConnection = {
      protocol: TERMINAL_CONNECTION_PROTOCOL,
      workspace: { id: identity.id, recoveryGeneration: identity.recoveryGeneration, label: "Toolroll" },
      principal: { account: principal.account, role: account.role, access: before.scope, expiresAt: new Date(credential.expiresAt).toISOString() },
      engine: { version: ENGINE_API_VERSION, contract: engineContractDigest() },
      capabilities,
    };
    const body = terminalConnectionSchema.safeParse(candidate);
    if (!body.success) return refuse(503, "contract-unavailable");
    const currentIdentity = store.workspaceIdentity();
    if (currentIdentity.id !== identity.id || currentIdentity.recoveryGeneration !== identity.recoveryGeneration) return refuse(503, "workspace-unavailable");
    const after = reproveRemote(store, principal, options.clock()), currentCredential = store.apiTokenSecret(principal.tokenId)?.row;
    if (!after.ok || after.scope !== before.scope || store.accountOf(principal.account)?.role !== account.role
      || currentCredential?.purpose !== "api" || currentCredential.expiresAt !== credential.expiresAt) return refuse(401, "unauthenticated");
    send(200, body.data);
  } catch {
    return refuse(503, "contract-unavailable");
  }
}

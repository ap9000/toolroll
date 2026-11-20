/** Disabled remote-terminal connection metadata. Credentials remain people, never local-owner sessions. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import { reproveRemote, type Principal } from "./operate-remote.js";
import { adapterPolicy } from "./server/route-policy.js";
import { engineContractDigest, ENGINE_API_VERSION } from "./contracts/engine-api.js";
import { DISABLED_TERMINAL_CAPABILITIES, TERMINAL_CONNECTION_PROTOCOL, terminalConnectionSchema, type TerminalConnection } from "./contracts/terminal-connection.js";
import type { Admission } from "./request-budget.js";

export type TerminalConnectionOptions = {
  store: Store;
  clock: () => Date;
  authenticate: (request: IncomingMessage) => Principal | null;
  admit?: (principal: Principal) => Admission;
};

/** Handles only the explicitly registered GET. No credential, cookie, link or grant is created. */
export function handleTerminalConnection(request: IncomingMessage, response: ServerResponse, options: TerminalConnectionOptions): void {
  const send = (status: number, value: unknown): void => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "pragma": "no-cache", "x-content-type-options": "nosniff" });
    response.end(JSON.stringify(value));
  };
  const refuse = (status: number, error: "request" | "unauthenticated" | "credential-purpose" | "workspace-unavailable" | "contract-unavailable"): void => {
    request.resume(); send(status, { protocol: TERMINAL_CONNECTION_PROTOCOL, error });
  };
  const names = request.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
  if (request.method !== "GET" || request.url !== "/engine/connection" || names.includes("cookie") || names.includes("origin") || names.includes("referer")
    || names.some(name => name.startsWith("sec-fetch-")) || names.filter(name => name === "authorization").length !== 1
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
    const candidate: TerminalConnection = {
      protocol: TERMINAL_CONNECTION_PROTOCOL,
      workspace: { id: identity.id, recoveryGeneration: identity.recoveryGeneration, label: "Toolroll" },
      principal: { account: principal.account, role: account.role, access: before.scope, expiresAt: new Date(credential.expiresAt).toISOString() },
      engine: { version: ENGINE_API_VERSION, contract: engineContractDigest() },
      capabilities: { ...DISABLED_TERMINAL_CAPABILITIES, commands: [] },
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

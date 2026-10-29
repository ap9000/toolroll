/**
 * `toolroll up` as two processes (docs/plans/isolated-checks.md, stage 1): the console (HTTP: serving, reading and the
 * person's ceremonies) and the worker (the watch loops: builds, checks, batch checks, follow-ups, reconcilers, the
 * storage sweep and checkout sizing). `up` itself keeps the identities it minted (the approver's login, the runner and
 * its token), supervises both with controller-supervisor, and relays between them. Nothing here grants authority:
 * each role is handed only what it needs, by message, never on a command line or in the environment.
 *
 * What each holds:
 *   console  the database, the console's own session and sign-in secrets, the attach (instance) secret, push keys, the
 *            port. Never the runner token: it can't claim, lease or build.
 *   worker   the database and the runner name and token, for the watch leases and claims. It opens no port and mints
 *            no console session or attach secret.
 * Both are the same user on the same database folder, so files beside the database (the saved login, tool secrets)
 * are reachable by either: the split keeps secrets out of each other's memory and messages, not out of the folder.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export type UpRoleName = "console" | "worker";

export type UpConsoleConfig = {
  host: string;
  port: number;
  allowedHosts: string[] | null;
  publicUrl: string | null;
  localRunner: string;
  poolRoot: string;
  repos: string[];
  projectRoots: string[];
  registryPath: string;
  editor: boolean;
};

export type UpWorkerConfig = {
  runner: string;
  token: string;
  repos: string[];
  pinnedRepos: string[];
  projectRoots: string[];
  registryPath: string;
  pool: string;
  forMs: number | null;
  publicUrl: string | null;
  stopGraceMs: number;
  verbose: boolean;
  terminal: boolean;
  /** How long a start waits for a predecessor's watch lease to expire (a crashed worker's, after a restart). */
  leaseWaitMs: number;
};

export type UpRoleStart =
  | { type: "start"; role: "console"; databaseFile: string; containment: string | null; build: string; config: UpConsoleConfig }
  | { type: "start"; role: "worker"; databaseFile: string; containment: string | null; build: string; config: UpWorkerConfig };

export type ParentToRole =
  | { type: "repos"; repos: string[] }
  | { type: "stopping" }
  | { type: "hard-stop" }
  | { type: "sign-in-link"; id: number; account: string };

export type RoleToParent =
  | { type: "ready"; role: UpRoleName; build: string; pid: number; url: string | null; port: number | null }
  | { type: "log"; line: string }
  | { type: "repos"; repos: string[] }
  | { type: "failed"; reason: "port-busy" | "start"; detail: string }
  | { type: "fatal"; detail: string }
  | { type: "sign-in-link"; id: number; link: string | null }
  | { type: "closed"; problem: string | null };

/** One role's side of the channel: the same shape over IPC (a child process) and in memory (one process). */
export type RolePort = {
  send: (message: RoleToParent) => void;
  onMessage: (handler: (message: ParentToRole) => void) => void;
  /** First call: drain. Every later call: stop now (the second signal's hard stop). */
  onStop: (handler: (hard: boolean) => void) => void;
};

const MAX_TEXT = 16_384;
const MAX_LIST = 4_096;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = MAX_TEXT): value is string => typeof value === "string" && value.length <= max;
const nonEmpty = (value: unknown, max = MAX_TEXT): value is string => text(value, max) && value !== "" && !value.includes("\0");
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_LIST && value.every(one => nonEmpty(one));
const whole = (value: unknown, min = 0, max = 2_147_483_647): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const orNull = <T>(value: unknown, check: (one: unknown) => one is T): boolean => value === null || check(value);

/** The parent's word to a role, checked before anything acts on it. */
export function parentMessage(value: unknown): ParentToRole | null {
  if (!isObject(value)) return null;
  switch (value["type"]) {
    case "repos": return texts(value["repos"]) ? { type: "repos", repos: [...value["repos"]] } : null;
    case "stopping": return { type: "stopping" };
    case "hard-stop": return { type: "hard-stop" };
    case "sign-in-link": return whole(value["id"]) && nonEmpty(value["account"], 256) ? { type: "sign-in-link", id: value["id"], account: value["account"] } : null;
    default: return null;
  }
}

/** A role's word to the parent, checked before the parent relays or acts on it. */
export function roleMessage(value: unknown, role: UpRoleName): RoleToParent | null {
  if (!isObject(value)) return null;
  switch (value["type"]) {
    case "ready":
      if (value["role"] !== role || !nonEmpty(value["build"], 512) || !whole(value["pid"], 1)) return null;
      if (!orNull(value["url"], (one): one is string => nonEmpty(one, 2_048)) || !orNull(value["port"], (one): one is number => whole(one, 1, 65_535))) return null;
      // Only the console serves: a worker that names an address is not a worker.
      if (role === "worker" && (value["url"] !== null || value["port"] !== null)) return null;
      if (role === "console" && (value["url"] === null || value["port"] === null)) return null;
      return { type: "ready", role, build: value["build"], pid: value["pid"], url: value["url"] as string | null, port: value["port"] as number | null };
    case "log": return text(value["line"]) ? { type: "log", line: value["line"] } : null;
    case "repos": return role === "worker" && texts(value["repos"]) ? { type: "repos", repos: [...value["repos"]] } : null;
    case "failed": return (value["reason"] === "port-busy" || value["reason"] === "start") && text(value["detail"]) ? { type: "failed", reason: value["reason"], detail: value["detail"] } : null;
    case "fatal": return text(value["detail"]) ? { type: "fatal", detail: value["detail"] } : null;
    case "sign-in-link": return role === "console" && whole(value["id"]) && orNull(value["link"], (one): one is string => nonEmpty(one, 2_048)) ? { type: "sign-in-link", id: value["id"], link: value["link"] as string | null } : null;
    case "closed": return orNull(value["problem"], (one): one is string => text(one)) ? { type: "closed", problem: value["problem"] as string | null } : null;
    default: return null;
  }
}

/** The start message a role child waits for. The console's config carries no runner token; anything else refuses. */
export function startMessage(value: unknown): UpRoleStart | null {
  if (!isObject(value) || value["type"] !== "start" || !nonEmpty(value["databaseFile"], 4_096) || !orNull(value["containment"], (one): one is string => nonEmpty(one, 64)) || !nonEmpty(value["build"], 512)) return null;
  const config = value["config"];
  if (!isObject(config)) return null;
  const base = { type: "start" as const, databaseFile: value["databaseFile"], containment: value["containment"] as string | null, build: value["build"] };
  if (value["role"] === "console") {
    const keys = ["host", "port", "allowedHosts", "publicUrl", "localRunner", "poolRoot", "repos", "projectRoots", "registryPath", "editor"];
    if (Object.keys(config).some(key => !keys.includes(key))) return null;
    if (!nonEmpty(config["host"], 253) || !whole(config["port"], 0, 65_535) || !orNull(config["allowedHosts"], texts) || !orNull(config["publicUrl"], (one): one is string => nonEmpty(one, 2_048)) ||
      !nonEmpty(config["localRunner"], 256) || !nonEmpty(config["poolRoot"], 4_096) || !texts(config["repos"]) || !texts(config["projectRoots"]) || !nonEmpty(config["registryPath"], 4_096) || typeof config["editor"] !== "boolean") return null;
    return { ...base, role: "console", config: config as unknown as UpConsoleConfig };
  }
  if (value["role"] === "worker") {
    const keys = ["runner", "token", "repos", "pinnedRepos", "projectRoots", "registryPath", "pool", "forMs", "publicUrl", "stopGraceMs", "verbose", "terminal", "leaseWaitMs"];
    if (Object.keys(config).some(key => !keys.includes(key))) return null;
    if (!nonEmpty(config["runner"], 256) || !nonEmpty(config["token"], 1_024) || !texts(config["repos"]) || !texts(config["pinnedRepos"]) || !texts(config["projectRoots"]) ||
      !nonEmpty(config["registryPath"], 4_096) || !nonEmpty(config["pool"], 4_096) || !orNull(config["forMs"], (one): one is number => whole(one, 1)) ||
      !orNull(config["publicUrl"], (one): one is string => nonEmpty(one, 2_048)) || !whole(config["stopGraceMs"], 0) || typeof config["verbose"] !== "boolean" || typeof config["terminal"] !== "boolean" || !whole(config["leaseWaitMs"], 0)) return null;
    return { ...base, role: "worker", config: config as unknown as UpWorkerConfig };
  }
  return null;
}

/** Two ends of an in-memory channel: one process composing both roles (tests and the desktop host), same messages. */
export function memoryChannel(role: UpRoleName): { port: RolePort; parent: { send: (message: ParentToRole) => void; onMessage: (handler: (message: RoleToParent) => void) => void; stop: (hard: boolean) => void } } {
  const toParent: ((message: RoleToParent) => void)[] = [];
  const toRole: ((message: ParentToRole) => void)[] = [];
  const stops: ((hard: boolean) => void)[] = [];
  // Delivered on a later turn, as IPC would be, and through the same checks: a role can't lean on synchronous replies.
  const later = (fn: () => void): void => { queueMicrotask(fn); };
  return {
    port: {
      send: message => { const checked = roleMessage(JSON.parse(JSON.stringify(message)), role); if (checked !== null) later(() => { for (const one of toParent) one(checked); }); },
      onMessage: handler => { toRole.push(handler); },
      onStop: handler => { stops.push(handler); },
    },
    parent: {
      send: message => { const checked = parentMessage(JSON.parse(JSON.stringify(message))); if (checked !== null) later(() => { for (const one of toRole) one(checked); }); },
      onMessage: handler => { toParent.push(handler); },
      stop: hard => { for (const one of stops) one(hard); },
    },
  };
}

/** A build identity: the version and the exact code of the module that composes `up`. Both roles must report the
 * parent's own, or the parent stops rather than run a console and a worker from different builds. */
export function buildIdentity(version: string, moduleFile: string): string {
  let digest = `unreadable-${randomUUID()}`;
  try { digest = createHash("sha256").update(readFileSync(moduleFile)).digest("hex").slice(0, 16); } catch { /* unique: never equal to any other identity */ }
  return `${version}+${digest}`;
}

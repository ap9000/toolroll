/**
 * `toolroll tokens create|list|revoke|rotate` (v111): a person's own API tokens, from the terminal of the machine that
 * keeps the database. Every verb is a step-up: the person's own password, typed at a hidden prompt or piped with
 * --password-stdin, never an argument, never the remembered login, a lead token or a remote caller's token. A new
 * secret is written once, in the answer to create or rotate; nothing else ever shows it, and only its hash is kept.
 */
import { envelopeJson } from "./envelope.js";
import { daysLeft, mintApiToken, ROTATION_OVERLAP_MAX_MINUTES, ROTATION_OVERLAP_MINUTES, TOKEN_DAYS, tokenLive } from "./api-tokens.js";
import { canonicalProject, projectName } from "./project.js";
import { authenticateAccount } from "./scope.js";
import type { ApiTokenRow, Store } from "./store.js";

export const TOKENS_ACTIONS = ["create", "list", "revoke", "rotate"] as const;
type TokensAction = (typeof TOKENS_ACTIONS)[number];

/** The most a piped password may be: a password, not a file. */
export const PASSWORD_STDIN_BYTES = 4096;
/** Flags that would put a credential in argv. Refused by name, their values never echoed. */
const SECRET_FLAGS = ["password", "token", "token-file", "token-env"] as const;

export type TokensCliContext = {
  store: Store;
  write: (line: string) => void;
  json: boolean;
  clock: () => Date;
  /** Who runs this: a remote caller (an API token, over /api/cli or /mcp) and the lead never manage tokens. */
  caller: "local" | "remote" | "lead";
  /** The remembered local login's name only (never its password): the default for --as. */
  rememberedName: string | null;
  /** Whether someone is at this terminal to answer a prompt. */
  interactive: () => boolean;
  ask: (question: string) => Promise<string>;
  askHidden: (question: string) => Promise<string>;
  /** Standard input, read whole up to `limit` bytes; null past the limit. */
  readStdin: (limit: number) => Promise<string | null>;
};

const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

export async function runTokensCommand(positional: readonly string[], flags: ReadonlyMap<string, string | true>, context: TokensCliContext): Promise<number> {
  const { store, write, json } = context;
  const action = positional[0];
  const command = action === undefined ? "tokens" : `tokens ${action}`;
  const fail = (reason: string, message: string, code: number = EXIT.refused) => { write(json ? envelopeJson({ ok: false, command, reason, message }) : message); return code; };
  const succeed = (data: Record<string, unknown>, lines: string[]) => { write(json ? envelopeJson({ ok: true, command, ...data }) : lines.join("\n")); return EXIT.ok; };
  const text = (name: string) => { const value = flags.get(name); return typeof value === "string" ? value : undefined; };

  if (action === undefined || !(TOKENS_ACTIONS as readonly string[]).includes(action)) {
    return fail("usage", `Use toolroll tokens ${TOKENS_ACTIONS.join("|")}.`, EXIT.usage);
  }
  if (context.caller === "remote") return fail("remote-refused", "API tokens are managed in the console or on the server's own machine, never with a token.");
  if (context.caller === "lead") return fail("lead-refused", "The lead can't manage your API tokens. Run this yourself.");
  const secretFlag = SECRET_FLAGS.find(name => flags.has(name));
  if (secretFlag !== undefined) return fail("usage", `--${secretFlag} isn't accepted here: type your password at the prompt, or pipe it with --password-stdin.`, EXIT.usage);

  // Check the terms before asking for anything, so a typo never spends a password try.
  const verb = action as TokensAction;
  const terms = verb === "create" ? createTerms(flags) : null;
  if (terms !== null && "problem" in terms) return fail("usage", terms.problem, EXIT.usage);
  const ref = positional[1]?.trim() ?? "";
  if ((verb === "revoke" || verb === "rotate") && (ref === "" || positional.length > 2)) return fail("usage", `Use toolroll tokens ${verb} <name|id>.`, EXIT.usage);
  if ((verb === "create" || verb === "list") && positional.length > 1) return fail("usage", `toolroll tokens ${verb} takes no other words.`, EXIT.usage);
  const overlap = verb === "rotate" ? overlapMinutes(text("overlap")) : null;
  if (overlap !== null && typeof overlap === "string") return fail("usage", overlap, EXIT.usage);

  // Who, then their password: never the remembered login's password, never an argument.
  let name = text("as")?.trim() ?? context.rememberedName ?? undefined;
  const fromStdin = flags.has("password-stdin");
  if (!fromStdin && (!context.interactive() || json)) return fail("usage", "Type your password at the prompt (run this in a terminal), or pipe it with --password-stdin.", EXIT.usage);
  if (name === undefined || name === "") {
    if (fromStdin || !context.interactive()) return fail("usage", "Say who you are with --as <your name>.", EXIT.usage);
    name = (await context.ask("username: ")).trim();
  }
  let password: string | null;
  if (fromStdin) {
    const piped = await context.readStdin(PASSWORD_STDIN_BYTES);
    password = piped === null ? null : piped.replace(/\r?\n$/, "");
    if (password === null) return fail("usage", "Pipe only your password into --password-stdin.", EXIT.usage);
  } else {
    password = await context.askHidden("password: ");
  }
  if (name === "" || password === "") return fail("unauthenticated", "Your name and password are needed.");
  const signedIn = authenticateAccount(store, name, password);
  password = null;
  if (!signedIn.ok) return fail(signedIn.reason === "locked" ? "locked" : "unauthenticated", signedIn.reason === "locked" ? "Too many wrong passwords: wait a while, then try again." : "That name and password don't match an account.");

  const now = context.clock();
  const mine = () => store.apiTokens(name!);

  if (verb === "list") {
    const tokens = mine().filter(one => tokenLive(one, now.getTime())).map(one => listed(one, now));
    return succeed({ tokens }, tokens.length === 0 ? ["You have no API tokens. Make one with toolroll tokens create."] : tokens.map(one =>
      `${one.name} · ${one.id} · ${one.access === "act" ? "acts" : "reads"} · ${one.projects === null ? "all your projects" : one.projects.length === 0 ? "no projects" : one.projects.map(projectName).join(", ")} · ` +
      `made ${one.createdAt.slice(0, 10)} · last used ${one.lastUsedAt === null ? "never" : one.lastUsedAt.slice(0, 10)} · ` +
      (one.stopsAt !== null ? `replaced; stops ${one.stopsAt.slice(0, 16).replace("T", " ")} UTC` : `expires ${one.expiresAt.slice(0, 10)}${one.daysLeft <= 7 ? ` (in ${one.daysLeft} day${one.daysLeft === 1 ? "" : "s"})` : ""}`)));
  }

  if (verb === "create") {
    const { tokenName, access, days, projectWords } = terms as CreateTerms;
    if (access === "act" && signedIn.role !== "approver") return fail("viewer", "Your account can watch, not act, so its tokens can only read. Use --access read.");
    const projects = projectWords === null ? null : resolveProjects(store, name, projectWords);
    if (projects !== null && "problem" in projects) return fail("unknown-project", projects.problem);
    const minted = mintApiToken();
    const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
    store.createApiToken({ id: minted.id, account: name, name: tokenName, secretHash: minted.hash, access, expiresAt, by: name, projects: projects?.paths ?? null }, now);
    const row = store.apiTokenSecret(minted.id)!.row;
    return succeed({ token: minted.token, ...listed(row, now) }, shownOnce(row, minted.token));
  }

  const found = resolveToken(mine(), ref, now, verb === "rotate");
  if ("problem" in found) return fail(found.reason, found.problem);
  if (verb === "revoke") {
    store.revokeApiToken(found.row.id, name, now);
    return succeed({ id: found.row.id, name: found.row.name }, [`Revoked ${found.row.name}. Anything using it stops working now.`]);
  }
  const minted = mintApiToken();
  const rotated = store.rotateApiToken(found.row.id, { id: minted.id, secretHash: minted.hash }, name, now, (overlap as number) * 60_000);
  if (!rotated.ok) return fail(rotated.reason === "replaced" ? "replaced" : "not-found", rotated.reason === "replaced" ? "That token was already replaced. Rotate its replacement instead." : "No live token of yours has that name or id.");
  const stops = store.apiTokenSecret(found.row.id)!.row.overlapUntil!;
  return succeed({ token: minted.token, replaced: { id: found.row.id, stopsAt: stops }, ...listed(rotated.row, now) }, [
    ...shownOnce(rotated.row, minted.token),
    `The old ${found.row.name} (${found.row.id}) keeps working until ${stops.slice(0, 16).replace("T", " ")} UTC, then stops.`,
  ]);
}

type CreateTerms = { tokenName: string; access: "read" | "act"; days: number; projectWords: string[] | null };

function createTerms(flags: ReadonlyMap<string, string | true>): CreateTerms | { problem: string } {
  const text = (name: string) => { const value = flags.get(name); return typeof value === "string" ? value : undefined; };
  const tokenName = (text("name") ?? "").trim().replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (tokenName === "" || tokenName.length > 60) return { problem: "Name the token with --name, in 60 characters or fewer." };
  const access = text("access");
  if (access !== "read" && access !== "act") return { problem: "Choose what it can do: --access read or --access act." };
  const daysText = text("days");
  const days = Number(daysText);
  if (daysText === undefined || !(TOKEN_DAYS as readonly number[]).includes(days)) return { problem: `Choose when it expires: --days ${TOKEN_DAYS.join(", ")}.` };
  const projectsText = text("projects");
  const projectWords = projectsText === undefined ? null : projectsText.split(",").map(one => one.trim()).filter(one => one !== "");
  if (projectWords !== null && projectWords.length === 0) return { problem: "Name at least one project with --projects, or leave it out for all your projects." };
  return { tokenName, access, days, projectWords };
}

function overlapMinutes(given: string | undefined): number | string {
  if (given === undefined) return ROTATION_OVERLAP_MINUTES;
  const minutes = Number(given);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= ROTATION_OVERLAP_MAX_MINUTES ? minutes : `--overlap is whole minutes, 0 to ${ROTATION_OVERLAP_MAX_MINUTES}.`;
}

/** Each named project, by path or by its name, among the projects this person may use now. */
function resolveProjects(store: Store, account: string, words: readonly string[]): { paths: string[] } | { problem: string } {
  const mine = [...new Set([...store.listProjects().map(one => one.path), ...store.knownRepos()])].filter(repo => store.accountCanAccess(account, repo));
  const paths: string[] = [];
  for (const word of words) {
    const exact = mine.find(repo => repo === word || repo === canonicalProject(word));
    const named = mine.filter(repo => projectName(repo) === word);
    const path = exact ?? (named.length === 1 ? named[0] : undefined);
    if (path === undefined) return { problem: named.length > 1 ? `More than one of your projects is called ${word}: give its path.` : `${word} isn't one of your projects.` };
    if (!paths.includes(path)) paths.push(path);
  }
  return { paths };
}

/** A token of this person's by exact id, else by a name only one of their current tokens has. */
function resolveToken(tokens: readonly ApiTokenRow[], ref: string, now: Date, current: boolean): { row: ApiTokenRow } | { reason: string; problem: string } {
  const live = tokens.filter(one => tokenLive(one, now.getTime()));
  const byId = live.find(one => one.id === ref);
  if (byId !== undefined) {
    if (current && byId.replacedBy !== null) return { reason: "replaced", problem: "That token was already replaced. Rotate its replacement instead." };
    return { row: byId };
  }
  const named = live.filter(one => one.name === ref && one.replacedBy === null);
  if (named.length > 1) return { reason: "ambiguous", problem: `More than one of your tokens is called ${ref}: use its id (toolroll tokens list).` };
  if (named.length === 0) return { reason: "not-found", problem: "No live token of yours has that name or id." };
  return { row: named[0]! };
}

/** What may be shown about a token: everything but its secret, which is never kept. */
function listed(row: ApiTokenRow, now: Date) {
  return {
    id: row.id, name: row.name, access: row.access, projects: row.projects, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, expiresAt: row.expiresAt,
    daysLeft: daysLeft(row.expiresAt, now.getTime()), stopsAt: row.replacedBy === null ? null : row.overlapUntil,
  };
}

function shownOnce(row: ApiTokenRow, token: string): string[] {
  return [
    `Your API token ${row.name}, shown once. Only a hash is kept, so copy it now:`,
    `  ${token}`,
    `It ${row.access === "act" ? "acts as you (never approves)" : "reads"} in ${row.projects === null ? "all your projects" : row.projects.map(projectName).join(", ")} until ${row.expiresAt.slice(0, 10)}.`,
  ];
}

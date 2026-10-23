/**
 * Project scripts (v84): a library of reusable steps that run with no AI.
 * A script is named — "run-tests", "enrich-lead", "export-orders" — and
 * made on a flow's Scripts panel or drafted by the lead in chat. v90: it is
 * written in shell, Python or Node, or runs a file already in the project.
 * Any flow in the project uses it by name from a "Run a script" zone (and a
 * schedule can run one to make cards), so one script can be improved once
 * for every flow, and the insights show how each script does across them.
 * Each save is a new version; runs record which ran.
 */
import { createHash } from "node:crypto";
import { scanForSecrets } from "./evidence.js";
import { SCRIPT_LANGUAGES, SCRIPT_NAME, type ScriptLanguage } from "./flows.js";
import type { Store } from "./store.js";

export type ScriptDraft = { name: string; about: string; body: string; timeoutMinutes: number; language: ScriptLanguage; file: string | null };

/** A script as it would be saved, checked in plain words. Throws. */
export function validateScript(input: { name?: unknown; about?: unknown; body?: unknown; timeoutMinutes?: unknown; language?: unknown; file?: unknown }): ScriptDraft {
  const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
  if (!SCRIPT_NAME.test(name)) throw new Error("Name the script in lowercase letters, numbers and dashes, like run-tests.");
  const about = typeof input.about === "string" ? input.about.replace(/\s+/g, " ").trim() : "";
  if (about === "" || about.length > 160) throw new Error("Say in one line what the script checks or does.");
  const language = input.language === undefined || input.language === null || input.language === "" ? "shell" : input.language;
  if (!SCRIPT_LANGUAGES.includes(language as ScriptLanguage)) throw new Error("Choose the script's language: shell, Python or Node.");
  const file = typeof input.file === "string" && input.file.trim() !== "" ? input.file.trim().replace(/^\.\//, "") : null;
  if (file !== null && (file.length > 200 || file.startsWith("/") || file.split(/[\\/]/).includes("..") || !/^[A-Za-z0-9._/@+-]+$/.test(file))) throw new Error("Give the file as a path inside the project, like scripts/enrich.py.");
  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").trim() : "";
  if (body === "" && file === null) throw new Error("Write the script, or name a file in the project for it to run.");
  if (body !== "" && file !== null) throw new Error("A script either is written here or runs a file in the project, not both.");
  if (body.length > 20_000) throw new Error("Keep a script under 20,000 characters.");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) throw new Error("The script has hidden characters in it.");
  if (scanForSecrets(`${about}\n${body}`).length > 0) throw new Error("That looks like a key or password. Keep secrets out of scripts; read them from the environment on this computer.");
  const minutes = typeof input.timeoutMinutes === "number" && Number.isFinite(input.timeoutMinutes) ? Math.round(input.timeoutMinutes) : typeof input.timeoutMinutes === "string" && input.timeoutMinutes.trim() !== "" ? Number(input.timeoutMinutes) : 15;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error("A script may run for 1 to 60 minutes.");
  return { name, about, body, timeoutMinutes: minutes, language: language as ScriptLanguage, file };
}

/** What a run is held to. A shell script written here keeps its v84 digest. */
export const scriptDigest = (draft: Pick<ScriptDraft, "body" | "timeoutMinutes"> & Partial<Pick<ScriptDraft, "language" | "file">>) =>
  createHash("sha256").update((draft.language ?? "shell") === "shell" && (draft.file ?? null) === null ? `${draft.body}\0${draft.timeoutMinutes}` : `${draft.body}\0${draft.timeoutMinutes}\0${draft.language}\0${draft.file ?? ""}`).digest("hex").slice(0, 32);

export type ScriptSaved = { ok: true; said: string; version: number } | { ok: false; message: string };

/** Save a script (a new version when it exists). */
export function saveScript(store: Store, repo: string, input: Parameters<typeof validateScript>[0], actor: string, now: Date): ScriptSaved {
  let draft: ScriptDraft;
  try { draft = validateScript(input); } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "That script isn't valid." }; }
  const current = store.flowScript(repo, draft.name);
  if (current !== null && current.digest === scriptDigest(draft) && current.about === draft.about) return { ok: true, said: "No changes to save.", version: current.version };
  const version = store.saveFlowScript({ repo, ...draft, digest: scriptDigest(draft), by: actor }, now);
  return { ok: true, said: current === null ? `Saved the ${draft.name} script. Any flow in this project can run it.` : `Saved version ${version} of ${draft.name}. Every flow that runs it uses this version from now on.`, version };
}


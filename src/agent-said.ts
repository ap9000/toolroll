/**
 * What the agent said last before a build stopped: the seam the step cards read (engine-reads.ts failureOf), and the one
 * shape every surface gets. The engine side keeps a short tail of the agent's own output per run and gives it here
 * through the store (`agentSaidTail(runId)`, optional until it lands); whatever it gives is bounded and cleaned again
 * here, so no surface ever draws more than AGENT_SAID_LINES lines of plain text.
 */
import type { Store } from "./store.js";

/** At most this many lines, the last ones. */
export const AGENT_SAID_LINES = 8;
/** Each line cut to this many characters. */
export const AGENT_SAID_WIDTH = 200;

type TailReader = { agentSaidTail?: (runId: number) => readonly string[] | null };

/** Terminal escape sequences (CSI, and OSC up to its BEL or ST). */
const ESCAPES = new RegExp("\\u001b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?)", "g");
/** Control, zero-width and bidi characters. */
const CONTROLS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]", "g");

/** One line as plain text: control and bidi characters gone, whitespace folded, cut to AGENT_SAID_WIDTH. */
export function agentSaidLine(line: string): string {
  const plain = line.replace(ESCAPES, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
  return plain.length <= AGENT_SAID_WIDTH ? plain : `${plain.slice(0, AGENT_SAID_WIDTH - 1)}…`;
}

/** The run's kept tail, cleaned and capped (blank lines dropped); null when there is none. */
export function agentSaidOf(store: Store, runId: number): string[] | null {
  const read = (store as unknown as TailReader).agentSaidTail;
  let raw: readonly string[] | null = null;
  try { raw = typeof read === "function" ? read.call(store, runId) : null; } catch { raw = null; }
  if (raw === null || !Array.isArray(raw)) return null;
  const lines = raw.filter((one): one is string => typeof one === "string").map(agentSaidLine).filter(one => one !== "");
  return lines.length === 0 ? null : lines.slice(-AGENT_SAID_LINES);
}

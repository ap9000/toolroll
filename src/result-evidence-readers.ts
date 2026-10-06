/** Shared verified readers for result screens and the compact CLI review. */
import type { Artifact } from "./store.js";
import { readVerifiedArtifact } from "./evidence.js";
import { hasForbiddenControls } from "./decision.js";
import { parseHandoffArtifact } from "./contracts/handoff.js";

const CAPTURE_EXIT = /\(exit ([0-9]{1,4})\)\s*$/;
export const SCREENSHOT_CAPTURE = /^agent-claimed screenshot at (.+) \(validated (?:png|jpeg)\)/;
const oneLineOf = (text: string, cap: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
};

/** What the run page shows of the terminal diff — verified bytes or a named problem, never silence. */
export type TerminalDiffView = {
  patch: { text: string; truncated: boolean; artifactId: number } | { problem: string } | null;
  stat:
    | {
        base: string;
        head: string;
        fileCount: number;
        additions: number;
        deletions: number;
        binaryCount: number;
        filesTruncated: boolean;
        files: { path: string; additions: number | null; deletions: number | null; renamedFrom?: string }[];
      }
    | { problem: string }
    | null;
};

/** A compact, typed view of the agent-authored handoff. Older v1
 * artifacts simply have no lists, while v2 can present the useful answer
 * before the raw diff and evidence below it. */
export type StructuredHandoffView = {
  conclusion: string;
  changes: string[];
  verification: string[];
  followUps: string[];
};

export function structuredHandoffView(artifacts: Artifact[], root: string, displayText: (text: string) => string = text => text): StructuredHandoffView | null {
  const artifact = [...artifacts].reverse().find(one => one.kind === "handoff");
  if (artifact === undefined) return null;
  const read = readVerifiedArtifact(root, artifact);
  if (!read.ok) return null;
  const parsed = parseHandoffArtifact(read.content.toString("utf8"));
  if (!parsed.ok) return null;
  const handoff = parsed.value;
  const conclusion = oneLineOf(displayText(handoff.conclusion), 600);
  if (conclusion === "" || hasForbiddenControls(conclusion)) return null;
  const list = (items: readonly string[] | undefined): string[] =>
    (items ?? [])
      .filter(one => one.trim() !== "" && !hasForbiddenControls(one))
      .slice(0, 8)
      .map(one => oneLineOf(one, 240));
  return { conclusion, changes: list(handoff.changes), verification: list(handoff.verification), followUps: list(handoff.followUps) };
}

/** A failed capture or unverifiable bytes keep their problem; absence returns null. */
export function terminalDiffView(artifacts: Artifact[], root: string): TerminalDiffView | null {
  const patchArtifact = artifacts.find(one => one.kind === "terminal-diff");
  const statArtifact = artifacts.find(one => one.kind === "diff-stat");
  if (patchArtifact === undefined && statArtifact === undefined) return null;

  const view: TerminalDiffView = { patch: null, stat: null };

  if (patchArtifact !== undefined) {
    const exit = CAPTURE_EXIT.exec(patchArtifact.capture);
    if (exit !== null && exit[1] !== "0") {
      view.patch = { problem: `capture failed — ${patchArtifact.capture}` };
    } else {
      const read = readVerifiedArtifact(root, patchArtifact);
      view.patch = read.ok
        ? { text: read.content.toString("utf8"), truncated: patchArtifact.truncated, artifactId: patchArtifact.id }
        : { problem: `stored but unverifiable — ${read.problem}` };
    }
  }

  if (statArtifact !== undefined) {
    const exit = CAPTURE_EXIT.exec(statArtifact.capture);
    if (exit !== null && exit[1] !== "0") {
      view.stat = { problem: `capture failed — ${statArtifact.capture}` };
    } else {
      const read = readVerifiedArtifact(root, statArtifact);
      if (!read.ok) {
        view.stat = { problem: `stored but unverifiable — ${read.problem}` };
      } else {
        try {
          const parsed = JSON.parse(read.content.toString("utf8")) as Record<string, unknown> | null;
          // Every field this page renders is type-proved (arc 6, finding 7):
          // "an object with a base key" was accepting any shape at all.
          const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
          const wellFormed =
            parsed !== null &&
            typeof parsed === "object" &&
            typeof parsed["base"] === "string" &&
            typeof parsed["head"] === "string" &&
            count(parsed["fileCount"]) &&
            count(parsed["additions"]) &&
            count(parsed["deletions"]) &&
            count(parsed["binaryCount"]) &&
            typeof parsed["filesTruncated"] === "boolean" &&
            Array.isArray(parsed["files"]) &&
            (parsed["files"] as unknown[]).every(
              one =>
                one !== null &&
                typeof one === "object" &&
                typeof (one as Record<string, unknown>)["path"] === "string" &&
                (count((one as Record<string, unknown>)["additions"]) || (one as Record<string, unknown>)["additions"] === null) &&
                (count((one as Record<string, unknown>)["deletions"]) || (one as Record<string, unknown>)["deletions"] === null),
            );
          view.stat = wellFormed
            ? (parsed as unknown as TerminalDiffView["stat"])
            : { problem: "stat is not the shape this page knows" };
        } catch {
          view.stat = { problem: "stat did not parse as JSON" };
        }
      }
    }
  }

  return view;
}

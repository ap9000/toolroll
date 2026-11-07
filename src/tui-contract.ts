/**
 * What the terminal UI (src/tui, bundled into dist/tui.js) reads and asks for, and nothing more. The CLI side
 * (tui-source.ts) implements it with in-process reads of this installation's database and with every write sent
 * through `runOperate` as the local owner (local-owner.ts runAsLocalOwner), so the screen holds no authority of its
 * own: a write the local owner may not make is refused there, and the screen shows the refusal's words.
 *
 * Types only, with no imports: both the CLI build (tsc) and the terminal UI bundle (esbuild) read this file.
 */

/** One task in the list, as the board says it. */
export type TuiRow = {
  readonly id: string;
  readonly title: string;
  /** The board's one status word (Needs you, Running, Ready, …). */
  readonly status: string;
  readonly detail: string;
  readonly needsYou: boolean;
  /** The attempt running now, if any: what Stop names. */
  readonly liveRunId: number | null;
  readonly repo: string | null;
};

/** A parked question on a task, answered by choosing one of its options. */
export type TuiDecision = { readonly id: number; readonly question: string; readonly options: readonly { readonly id: string; readonly label: string }[] };

/** One task in full. */
export type TuiTask = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly detail: string;
  /** The plan waiting for approval: its exact digest (what the yes binds) and every line of it. Null: none waits. */
  readonly plan: { readonly digest: string; readonly lines: readonly string[] } | null;
  readonly liveRunId: number | null;
  /** A finished result that can be marked Complete or sent back with a revision. */
  readonly hasResult: boolean;
  readonly decisions: readonly TuiDecision[];
  /** "Can I merge?" (merge-checklist.ts, `toolroll task ready`'s lines): the answer, then each check. Empty: no result. */
  readonly ready?: readonly string[];
};

/** The welcome's steps, as lines (welcome-facts.ts). */
export type TuiSetup = { readonly left: number; readonly lines: readonly string[] };

export type TuiSnapshot = {
  readonly rows: readonly TuiRow[];
  /** One line about what waits on the person, or null when nothing does. */
  readonly needsYou: string | null;
  /** The projects tasks can be filed in (the first is the default). */
  readonly projects: readonly string[];
  /** Whether the local owner has set a password (decides where a refusal leads). */
  readonly passwordSet: boolean;
};

export type TuiAct =
  | { readonly kind: "new"; readonly text: string; readonly repo: string | null }
  /** Build: the terms the person just read (fast-start.ts). */
  | { readonly kind: "build"; readonly preview: string; readonly digest: string }
  | { readonly kind: "approve"; readonly id: string; readonly digest: string }
  | { readonly kind: "stop"; readonly id: string; readonly runId: number }
  | { readonly kind: "revise"; readonly id: string; readonly text: string }
  | { readonly kind: "complete"; readonly id: string }
  | { readonly kind: "retry"; readonly id: string }
  | { readonly kind: "answer"; readonly decision: number; readonly option: string };

/** What Build would approve: the same lines every approval surface reads. */
export type TuiFastTerms = { readonly preview: string; readonly digest: string; readonly terms: readonly { readonly label: string; readonly words: string }[] };

/** A write's answer: its words. `needsPassword`: refused because the local owner may not do it. */
export type TuiActResult = { readonly ok: true; readonly message: string; readonly id?: string } | { readonly ok: false; readonly message: string; readonly needsPassword: boolean };

/** The plane, as the screen sees it. */
export interface TuiSource {
  snapshot(): Promise<TuiSnapshot>;
  task(id: string): Promise<TuiTask | null>;
  /** The newest output lines of the task's live attempt (empty when none runs). */
  live(id: string): readonly string[];
  /** A counter that moves when the plane's work changes (the store's wake sequence). */
  changed(): number;
  act(act: TuiAct): Promise<TuiActResult>;
  /** A small task's exact terms, or null when it takes the ordinary road (New task then files it). */
  fastTerms(text: string, repo: string | null): Promise<TuiFastTerms | null>;
  /** The welcome's steps, or null once setup is done. */
  setup(): Promise<TuiSetup | null>;
}

/** What only the process that opened the screen knows: whether quitting stops its agents, the browser, the ask-once. */
export interface TuiSession {
  /** Quitting would stop the Toolroll this terminal started (no background service runs it). */
  owned(): boolean;
  /** Open this computer's browser on the console, signed in. Resolves with what to say. */
  openBrowser(): Promise<string>;
  /** Whether to ask, now, "Keep Toolroll running in the background?" (once per installation). */
  shouldAskBackground(): boolean;
  /** Record the answer; yes moves Toolroll to the background service. Resolves with what to say. */
  answerBackground(yes: boolean): Promise<string>;
}

/** How the screen ended: leave as it is, stop the agents this terminal started, or keep them running in the background. */
export type TuiExit = "leave" | "stop" | "keep";

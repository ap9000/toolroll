/** People's names for task commands (docs/plans/plain-toolroll.md P1.3): each is exactly the command it names, read
 * before anything else looks at the command, so a remote, local-owner or contract rule sees only the original. */
export const TASK_ALIASES: Readonly<Record<string, string>> = { "send-back": "revise", retry: "requeue", recheck: "regate" };

/** `task <alias> …` as the command it names; anything else unchanged. */
export function withTaskAlias(argv: readonly string[]): readonly string[] {
  if (argv[0] !== "task" || argv[1] === undefined || !Object.prototype.hasOwnProperty.call(TASK_ALIASES, argv[1])) return argv;
  return ["task", TASK_ALIASES[argv[1]]!, ...argv.slice(2)];
}

/** Which invocations are an easy start (easy-start.ts), kept apart so the CLI's entry decides without loading it. */

export type EasyStartArgs = { web: boolean; projectRoot: string | null; port?: string | null };

/** The flags bare `toolroll` takes at a terminal (--web, --project-root <dir>, --port <n>), or null: not an easy start.
 * The port is checked where it is used (runEasyStart), so a bad one is told as such. */
export function easyStartArgs(argv: readonly string[]): EasyStartArgs | null {
  let web = false, projectRoot: string | null = null, port: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const one = argv[index]!;
    if (one === "--web" && !web) web = true;
    else if ((one === "--project-root" && projectRoot === null) || (one === "--port" && port === null)) {
      const value = argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("-")) return null;
      if (one === "--port") port = value;
      else projectRoot = value;
      index += 1;
    } else return null;
  }
  return { web, projectRoot, port };
}

/** Whether this invocation is an easy start: only those flags, a person at a terminal, no coding agent. */
export function easyStartApplies(argv: readonly string[], facts: { stdin: boolean; stdout: boolean; agent: boolean }): boolean {
  return facts.stdin && facts.stdout && !facts.agent && easyStartArgs(argv) !== null;
}

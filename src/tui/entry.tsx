/**
 * The terminal UI bundle's entry (esbuild → dist/tui.js, scripts/browser-build.mjs). Ink, React and yoga-layout are
 * bundled in, so the installed package gains no runtime dependency. The CLI loads this file only through a dynamic
 * `import()` when the screen opens (easy-start.ts), never statically, so every other command stays as fast as today.
 * Running the file directly shows a sample screen.
 */
import { render } from "ink";
import { pathToFileURL } from "node:url";
import { App } from "./app.js";
import { sampleSession, sampleSource, type TuiExit, type TuiSession, type TuiSource } from "./data.js";

/** Shows the screen until the person quits, and says how they left. Refuses without an interactive terminal. */
export async function startTui(source: TuiSource = sampleSource(), session: TuiSession = sampleSession()): Promise<TuiExit> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The terminal UI needs an interactive terminal.");
  let how: TuiExit = "leave";
  // Ctrl-C is the screen's own key (it asks before stopping agents), never an abrupt exit.
  const instance = render(<App source={source} session={session} onExit={exit => { how = exit; }} />, { exitOnCtrlC: false });
  await instance.waitUntilExit();
  return how;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  startTui().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

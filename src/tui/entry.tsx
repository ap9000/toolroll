/**
 * The terminal UI bundle's entry (esbuild → dist/tui.js, scripts/browser-build.mjs). Ink, React and yoga-layout are
 * bundled in, so the installed package gains no runtime dependency. The CLI must load this file only through a dynamic
 * `import()` on the paths that show the terminal UI, never statically, so every other command stays as fast as today.
 * Nothing reaches it yet (wave 0a): running the file directly shows the sample screen.
 */
import { render } from "ink";
import { pathToFileURL } from "node:url";
import { App } from "./app.js";
import { sampleData, type TuiData } from "./data.js";

/** Shows the screen until the person quits. Refuses without an interactive terminal (Ink needs raw input). */
export async function startTui(data: TuiData = sampleData()): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The terminal UI needs an interactive terminal.");
  const instance = render(<App data={data} />);
  await instance.waitUntilExit();
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  startTui().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

import { spawn } from "node:child_process";

/** Event-driven barriers for deployment races: no timed sleeps or polling. */
export function deploymentChild(code: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "", ended = false;
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const messages: unknown[] = [];
  const readers: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  child.on("message", message => {
    const reader = readers.shift();
    if (reader) reader.resolve(message); else messages.push(message);
  });
  const closed = new Promise<{ code: number | null; signal: string | null; output: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      ended = true;
      for (const reader of readers.splice(0)) reader.reject(Error(`Deployment child exited: ${code}/${signal}\n${output}`));
      resolve({ code, signal, output });
    });
  });
  return {
    child, closed,
    message: () => messages.length ? Promise.resolve(messages.shift()) : ended
      ? Promise.reject(Error(`Deployment child already exited: ${output}`))
      : new Promise<unknown>((resolve, reject) => { readers.push({ resolve, reject }); }),
    async stop() { if (!ended) child.kill("SIGKILL"); await closed; },
  };
}

/** How Codex says it is signed in, read live (`codex login status`): the gateway's billing evidence, and the proof a
 * plan-pinned fallback agent needs before it runs (fallback.ts). */
import { run as runCommand } from "./exec.js";
import type { Billing } from "./spend.js";

/** How Codex says it's signed in (`codex login status`): a ChatGPT sign-in is its plan; a key or Bedrock is a key;
 * null when it says neither (not signed in, or it didn't answer). */
export async function codexLoginBilling(binary: string, omitEnv: readonly string[]): Promise<Billing | null> {
  try {
    const status = await runCommand(binary, ["login", "status"], { timeoutMs: 15_000, omitEnv, processGroup: true });
    const said = `${status.stdout}\n${status.stderr}`;
    return /using chatgpt/i.test(said) ? "subscription" : /api key|bedrock/i.test(said) ? "api-key" : null;
  } catch {
    return null;
  }
}

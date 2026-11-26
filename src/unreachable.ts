/** Why a server couldn't be reached, in plain words: a fetch that never got an answer (offline, blocked, slow). */
export function unreachableWhy(error: unknown, timeoutSeconds: number): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") return `it didn't answer within ${timeoutSeconds} seconds`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "its address couldn't be looked up (this computer may be offline)";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPERM" || code === "EACCES") return "the connection was refused or blocked";
  return "the connection failed (this computer may be offline, or a firewall blocks it)";
}

/** Whether fetch itself threw (no answer at all), as opposed to an answer that was read and rejected. */
export function neverAnswered(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || (error instanceof TypeError && error.message === "fetch failed");
}

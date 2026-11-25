/**
 * A rehearsal (docs/plans/release-from-main.md, part C): this process serves a COPY of someone's database for the
 * deploy check. Every process that copy records (a Direct Chat turn, a thread's launch, a run) is the real computer's,
 * never this process's: nothing here may signal one, whatever a reconciler decides, and nothing that recovers or keeps
 * up recorded work starts (serve.ts, server/direct-chat.ts, server/engine-api.ts read `inRehearsal`).
 *
 * As a belt, entering a rehearsal replaces `process.kill` for this process: an existence probe (signal 0) and a signal
 * to this process itself pass; any other signal to any other pid or group is refused (EPERM), and said. Custody's own
 * signal road (flexible-custody.ts realCustodyIO) refuses too, before it reaches the OS (its Linux road doesn't use
 * process.kill).
 */
let depth = 0;
let realKill: typeof process.kill | null = null;

/** Whether this process is serving a rehearsal now. */
export function inRehearsal(): boolean { return depth > 0; }

/** The refusal a rehearsal gives any signal to a recorded process. */
export const REHEARSAL_SIGNAL_REFUSED = "a rehearsal never signals a process: every pid in its database copy belongs to the real computer";

/** Enter a rehearsal; the returned function leaves it (once), restoring `process.kill` when the last one leaves. */
export function enterRehearsal(): () => void {
  if (depth === 0) {
    realKill = process.kill.bind(process);
    const real = realKill;
    process.kill = ((pid: number, signal?: string | number) => {
      if ((signal === 0 || signal === "0") || pid === process.pid) return real(pid, signal as never);
      throw Object.assign(new Error(`${REHEARSAL_SIGNAL_REFUSED} (pid ${pid}, ${String(signal ?? "SIGTERM")})`), { code: "EPERM" });
    }) as typeof process.kill;
  }
  depth += 1;
  let left = false;
  return () => {
    if (left) return;
    left = true;
    depth -= 1;
    if (depth === 0 && realKill !== null) { process.kill = realKill; realKill = null; }
  };
}

/**
 * Flexible projects (docs: the Flexible plan v2, slice F1): whether this build offers them at all.
 *
 * A compile-time constant, never a setting: no environment variable, config key, database row, flag or token reads or
 * changes it, and nothing here exports a way to. While it is false every Flexible writer refuses (enable, lower, off,
 * the delegation check a thread start makes), the CLI says it isn't available, and no page offers it. It is turned on
 * by changing this line in the release whose thread engine, chat and ship slices have passed their attack rows.
 *
 * Tests reach the enabled behaviour only by replacing this module with vi.mock; src/flexible-disabled.test.ts keeps
 * this file exactly one literal, imported only by name, so that seam can't become a runtime override.
 *
 * Never true before every enable gate holds (the Flexible plan v2, F2 breakdown "Enable gates"; status 2026-11-15).
 *
 * Done, behind this constant: the thread's own repository, keep-ref and fence (F2a); the Claude sign-in relay (F2b);
 * the thread start, level wiring and full process custody (F2c: setsid survivors found, nothing spawned before it is
 * registered, a durable process identity instead of a bare live_pid); answers delivered exactly once (F2d); turn
 * admission and limits (F2e); threads as live sessions in the terminal (F3); the controlled import with its
 * protected-name and placeholder filter, and one-press Ship (F4, in review as eight-fx4); and the pre-enable pieces: the
 * console's launcher (each launch's own run proxy under the project's network, its storage check, the proxy closed with
 * the launch), the start's terms card (bound by its key; the unknown-cost monthly hold said there), the laptop owner's
 * start as its own local-owner act, and the owner's view woken on change instead of polled.
 *
 * Left: the F0 real-model matrix (f0.md; the owner's yes for each batch); Claude's stdio permission channel proved
 * (F0 row H); Codex threads running inside the srt thread fence (until then flexibleThreadCodexProfile refuses them);
 * the bubblewrap attack runs green in CI (test/attacks/flexible-thread-fence.slow.test.ts, Linux native lane, no
 * skips); the import's quarantine proved against the real sandbox; the F5 CLI; and the docs (the guide page and
 * security.md's Flexible column), shipped in the release that turns this on.
 */
export const FLEXIBLE_AVAILABLE: boolean = false;

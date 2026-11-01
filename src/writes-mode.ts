/**
 * Where a build may write (docs/plans/agent-baseline-hardening.md arc 2). `workspace`: only its allowlist (agent-fence.ts
 * WriteAllowlist), whatever its permission mode; `anywhere`: anywhere its fence doesn't deny, as builds did before.
 */
export type WritesMode = "workspace" | "anywhere";
export const WRITES_DEFAULT: WritesMode = "workspace";
export const isWritesMode = (value: unknown): value is WritesMode => value === "workspace" || value === "anywhere";

/** What an approval card and the CLI say of where a build may write (absent: sealed before write allowlists). */
export function writesWords(writes: WritesMode | undefined): string {
  return writes === "workspace" ? "only its checkout, its caches and its temp folder"
    : writes === "anywhere" ? "anywhere outside Toolroll's fenced folders (an approver's choice)"
    : "anywhere outside Toolroll's fenced folders (approved before write limits)";
}

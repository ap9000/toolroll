/**
 * Deterministic JSON for digests and equality. These bytes are sealed into approvals and stored digests, so neither
 * function may change its output for any input. The two differ on purpose and must stay distinct:
 *
 * - `canonicalJson` drops object keys whose value is undefined and returns JSON.stringify's own answer for a bare
 *   value (an undefined array element therefore renders as nothing: `[,1]`).
 * - `canonicalJsonUndefinedAsNull` keeps every key and renders an undefined (or otherwise unserializable) value as
 *   `null` — the planner contract's bytes.
 *
 * Both sort object keys by UTF-16 code units and keep arrays in order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable JSON for hashing and equality only — no filling, no trimming; undefined reads as null. */
export function canonicalJsonUndefinedAsNull(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonUndefinedAsNull).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const body = value as Record<string, unknown>;
    return `{${Object.keys(body)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJsonUndefinedAsNull(body[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

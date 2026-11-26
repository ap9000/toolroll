/**
 * Text that may carry a name someone else chose (a path, a program's own words), made safe to show on one line of a
 * terminal without changing what it names: every character that could move the cursor, end the line, start an escape
 * sequence or reorder what is shown is written out as a visible escape instead (\n, \r, \t, \x1b, \u202e). C0 and C1
 * controls, DEL, line and paragraph separators, and every invisible format character (bidi embeddings, overrides and
 * isolates, zero-width characters, the BOM). A forged "Fix it with:" line can't appear: it stays on the line it came on.
 */
const UNSAFE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\p{Cf}]", "gu");
const NAMED: Readonly<Record<string, string>> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** `text` with each unsafe character escaped (see the header); everything else as it is. */
export function shownText(text: string): string {
  return text.replace(UNSAFE, char => {
    const named = NAMED[char];
    if (named !== undefined) return named;
    const code = char.codePointAt(0)!;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Whether `text` holds anything shownText would escape. */
export function hasUnsafeText(text: string): boolean {
  return new RegExp(UNSAFE.source, "u").test(text);
}

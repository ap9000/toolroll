/**
 * Text someone else wrote, made safe to print on a terminal: the one sanitizer the live view, `peek` and the terminal
 * UI share. Escape sequences in every form go (CSI in 7- or 8-bit form, OSC such as hyperlinks and title changes,
 * every other ESC sequence), and with them every C0 and C1 control character (a carriage return that would
 * overwrite a line, a backspace, a bell), every invisible format character and bidi override; a tab becomes a space.
 * Pure: no imports, so the terminal UI's bundle carries it as is.
 */

/** Bidi embedding, override and isolate controls. */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** One line: controls, escapes and bidi overrides out; tabs to spaces. A newline is a control here too. */
export function cleanTerminalLine(text: string): string {
  return text
    // Escape sequences in every form: CSI (7- or 8-bit, any parameter bytes including ':'), OSC, and the rest.
    .replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\x1b\]|\u009d)[^\x07\x1b\u009c]*(?:\x07|\x1b\\|\u009c)?/g, "")
    .replace(/\x1b[ -/]*[0-~]/g, "")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    // Every invisible format character (zero-width, direction marks and overrides, joiners, BOM): never shown.
    .replace(/\p{Cf}/gu, "")
    .replace(BIDI_CONTROLS, "");
}

/** Any text for the terminal UI: each line cleaned as above, its newlines kept (a lone carriage return is not one). */
export function terminalText(text: string): string {
  return text.split("\n").map(cleanTerminalLine).join("\n");
}

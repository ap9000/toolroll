import { StringDecoder } from "node:string_decoder";

/** Agent output only. Feed every byte through one instance per launch, before the mirror and live renderer.
 * This is not an authorization check or a snapshot serializer. Never flush raw pending bytes on error/reconnect.
 * UTF-8 decoding precedes control parsing: malformed bytes become replacement characters, never raw C1 controls.
 * Memory is bounded even for unterminated strings and oversized CSI. finish() drops partial controls permanently.
 */
export class TerminalSafetyFilter {
  private decoder = new StringDecoder("utf8");
  private state: "text" | "escape" | "csi" | "escape-intermediate" | "string" | "string-escape" = "text";
  private sequence = "";
  private osc = false;
  private ended = false;

  write(bytes: Uint8Array): string {
    if (this.ended) throw new Error("Terminal safety filter already finished");
    return this.parse(this.decoder.write(Buffer.from(bytes)));
  }

  finish(): string {
    if (this.ended) return "";
    const out = this.parse(this.decoder.end());
    this.ended = true;
    this.sequence = "";
    this.state = "text";
    return out;
  }

  private parse(text: string): string {
    const out: string[] = [];
    for (const char of text) {
      const code = char.codePointAt(0)!;
      // Control strings are consumed in constant space, including embedded ESCs and split STs.
      if (this.state === "string" || this.state === "string-escape") {
        if (code === 0x9c || (this.osc && code === 7) || (this.state === "string-escape" && char === "\\")) {
          this.state = "text";
        } else this.state = char === "\x1b" ? "string-escape" : "string";
        continue;
      }
      if (char === "\x1b") { this.state = "escape"; this.sequence = ""; continue; }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        this.osc = code === 0x9d; this.state = "string"; this.sequence = ""; continue;
      }
      if (code === 0x9b) { this.state = "csi"; this.sequence = ""; continue; }
      // CAN/SUB cancel a pending control, and cannot reach the renderer.
      if (code === 0x18 || code === 0x1a) { this.state = "text"; this.sequence = ""; continue; }
      if (this.state === "escape") {
        if (char === "[") { this.state = "csi"; continue; }
        if ("]PX^_".includes(char)) { this.osc = char === "]"; this.state = "string"; continue; }
        if (code >= 0x20 && code <= 0x2f) { this.state = "escape-intermediate"; continue; }
        // Cursor save/restore, index, next line, reverse index, application keypad.
        if ("78DEM=>".includes(char)) out.push(`\x1b${char}`);
        this.state = "text";
        continue;
      }
      if (this.state === "escape-intermediate") {
        if (code >= 0x30 && code <= 0x7e) this.state = "text";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) {
          if (allowedCsi(this.sequence, char)) out.push(`\x1b[${this.sequence}${char}`);
          this.sequence = ""; this.state = "text";
        } else if (this.sequence.length < 256 && code >= 0x20 && code <= 0x3f) {
          this.sequence += char;
        } else {
          // Stay in discard-until-final mode, never output a suffix of an oversized control.
          this.sequence = "!";
        }
        continue;
      }
      if ((code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) || "\b\t\n\r".includes(char)) out.push(char);
    }
    return out.join("");
  }
}

/** Explicit display and input-mode policy. No device/window/status queries, replies, resets or string commands.
 * Mixed allowed/unknown mode lists are dropped as a whole. Parameters are bounded, including SGR.
 */
function allowedCsi(params: string, final: string): boolean {
  if (params.length > 256 || params.includes("!")) return false;
  if (final === "h" || final === "l") {
    const privateMode = params.startsWith("?");
    const body = privateMode ? params.slice(1) : params;
    const modes = privateMode ? [1, 6, 7, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1047, 1048, 1049, 2004] : [4, 20];
    return /^\d+(;\d+)*$/.test(body) && body.split(";").every(n => modes.includes(Number(n)));
  }
  if (final === "m") return /^[\d;:]*$/.test(params);
  // Cursor motion/position, erase, insert/delete, scroll, margins and cursor save/restore.
  if ("ABCDEFGHIZ`adefJKLMPSTXrsu".includes(final)) return /^[\d;]*$/.test(params);
  // Cursor shape is display-only; no other intermediate-byte commands are admitted.
  return final === "q" && /^[0-6]? $/.test(params);
}

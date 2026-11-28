/**
 * Test support for the Gate 2 passkey suites: a minimal CBOR encoder to build WebAuthn attestationObjects and COSE
 * keys. Test-only; production code only ever decodes CBOR (webauthn.ts).
 */
import type { CborValue } from "./webauthn.js";

/** Minimal CBOR encoder for fixture attestationObjects / COSE keys. */
export function encodeCbor(value: CborValue): Buffer {
  const header = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("non_integer");
    return value >= 0 ? header(0, value) : header(1, -1 - value);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([header(2, value.length), value]);
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([header(3, b.length), b]);
  }
  if (Array.isArray(value)) return Buffer.concat([header(4, value.length), ...value.map(encodeCbor)]);
  if (value instanceof Map) {
    const parts: Buffer[] = [header(5, value.size)];
    for (const [k, v] of value.entries()) parts.push(encodeCbor(k), encodeCbor(v));
    return Buffer.concat(parts);
  }
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  throw new Error("unsupported_cbor");
}

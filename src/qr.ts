/**
 * A QR Code encoder (ISO/IEC 18004), byte mode only: enough to show a pairing payload in Settings and in a terminal.
 * No dependency: the algorithm follows the well-known reference design (Project Nayuki's QR Code generator, MIT):
 * Reed–Solomon over GF(2^8) with the 0x11D polynomial, the eight masks scored by the standard's four penalty rules.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

const ECC_ORDINAL: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two format bits each level writes (L=01, M=00, Q=11, H=10). */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index 0 is padding; rows are L, M, Q, H; columns are versions 1..40.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

/** A finished symbol: `size` × `size` modules, `dark(x, y)` true for a dark module. */
export interface QrCode {
  readonly version: number;
  readonly size: number;
  readonly ecc: QrEcc;
  readonly mask: number;
  dark(x: number, y: number): boolean;
}

/** Encodes `data` (UTF-8 for a string) in byte mode at the smallest version that fits, at `ecc` or better if it costs
 * no extra version. Throws when the data can't fit version 40. */
export function encodeQr(data: string | Uint8Array, ecc: QrEcc = "M"): QrCode {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let version = 1;
  let dataUsedBits = 0;
  for (; ; version++) {
    const capacityBits = numDataCodewords(version, ecc) * 8;
    dataUsedBits = 4 + (version <= 9 ? 8 : 16) + bytes.length * 8;
    if (dataUsedBits <= capacityBits) break;
    if (version >= 40) throw new RangeError("Data too long for a QR code");
  }
  // Boost the level while the data still fits this version.
  let level = ecc;
  for (const better of ["M", "Q", "H"] as const) {
    if (ECC_ORDINAL[better] > ECC_ORDINAL[level] && dataUsedBits <= numDataCodewords(version, better) * 8) level = better;
  }

  const bits: number[] = [];
  appendBits(bits, 0x4, 4); // byte mode
  appendBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) appendBits(bits, b, 8);
  const capacityBits = numDataCodewords(version, level) * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);

  const dataCodewords = new Array<number>(bits.length / 8).fill(0);
  bits.forEach((bit, i) => { dataCodewords[i >>> 3] = (dataCodewords[i >>> 3] ?? 0) | (bit << (7 - (i & 7))); });

  const symbol = new QrSymbol(version, level);
  symbol.drawFunctionPatterns();
  symbol.drawCodewords(symbol.addEccAndInterleave(dataCodewords));
  let bestMask = 0, minPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    symbol.applyMask(mask);
    symbol.drawFormatBits(mask);
    const penalty = symbol.penaltyScore();
    if (penalty < minPenalty) { bestMask = mask; minPenalty = penalty; }
    symbol.applyMask(mask); // XOR undoes it
  }
  symbol.applyMask(bestMask);
  symbol.drawFormatBits(bestMask);
  const modules = symbol.modules, size = symbol.size;
  return { version, size, ecc: level, mask: bestMask, dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && modules[y]![x]! };
}

/** The symbol as an SVG document: one path, a 4-module quiet zone, crisp edges. */
export function qrSvg(code: QrCode, opts: { title?: string; dark?: string; light?: string } = {}): string {
  const border = 4, dim = code.size + border * 2;
  let path = "";
  for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) {
    if (code.dark(x, y)) path += `M${x + border},${y + border}h1v1h-1z`;
  }
  const title = opts.title === undefined ? "" : `<title>${opts.title.replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`)}</title>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img">${title}` +
    `<rect width="100%" height="100%" fill="${opts.light ?? "#ffffff"}"/><path d="${path}" fill="${opts.dark ?? "#000000"}"/></svg>`;
}

/** The symbol for a terminal: two modules per character row (▀ ▄ █ and space), light quiet zone, dark modules drawn
 * as the terminal's background so it scans on light and dark themes when printed inverted. */
export function qrText(code: QrCode): string {
  const border = 2, lines: string[] = [];
  // Inverted: a "dark" module is printed as a space on a light block field, which scans on dark terminals.
  const on = (x: number, y: number) => !code.dark(x, y);
  for (let y = -border; y < code.size + border; y += 2) {
    let line = "";
    for (let x = -border; x < code.size + border; x++) {
      const top = on(x, y), bottom = on(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function appendBits(out: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) out.push((value >>> i) & 1);
}

function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number, ecc: QrEcc): number {
  const o = ECC_ORDINAL[ecc];
  return Math.floor(numRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[o]![version]! * NUM_ERROR_CORRECTION_BLOCKS[o]![version]!;
}

function rsMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => { result[i] = result[i]! ^ rsMultiply(coef, factor); });
  }
  return result;
}

class QrSymbol {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(readonly version: number, readonly ecc: QrEcc) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const align = this.alignmentPositions(), n = align.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this.drawAlignment(align[i]!, align[j]!);
    }
    this.drawFormatBits(0); // placeholder, overwritten per mask
    this.drawVersion();
  }

  drawFormatBits(mask: number): void {
    const data = (ECC_FORMAT_BITS[this.ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true); // the dark module
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0, a = this.size - 11 + (i % 3), b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
      if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4);
    }
  }

  private drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  addEccAndInterleave(data: readonly number[]): number[] {
    const o = ECC_ORDINAL[this.ecc];
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[o]![this.version]!;
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[o]![this.version]!;
    const rawCodewords = Math.floor(numRawDataModules(this.version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const blocks: number[][] = [];
    const divisor = rsDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const result: number[] = [];
    for (let i = 0; i < blocks[0]!.length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
      });
    }
    return result;
  }

  drawCodewords(data: readonly number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      let invert: boolean;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (!this.isFunction[y]![x] && invert) this.modules[y]![x] = !this.modules[y]![x];
    }
  }

  penaltyScore(): number {
    let result = 0;
    const size = this.size, m = this.modules;
    for (let y = 0; y < size; y++) {
      let runColor = false, runX = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (m[y]![x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1; else if (runX > 5) result++;
        } else {
          this.finderHistoryAdd(runX, history);
          if (!runColor) result += this.finderPenaltyCount(history) * PENALTY_N3;
          runColor = m[y]![x]!;
          runX = 1;
        }
      }
      result += this.finderTerminate(runColor, runX, history) * PENALTY_N3;
    }
    for (let x = 0; x < size; x++) {
      let runColor = false, runY = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (m[y]![x] === runColor) {
          runY++;
          if (runY === 5) result += PENALTY_N1; else if (runY > 5) result++;
        } else {
          this.finderHistoryAdd(runY, history);
          if (!runColor) result += this.finderPenaltyCount(history) * PENALTY_N3;
          runColor = m[y]![x]!;
          runY = 1;
        }
      }
      result += this.finderTerminate(runColor, runY, history) * PENALTY_N3;
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += PENALTY_N2;
    }
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  private finderPenaltyCount(h: readonly number[]): number {
    const n = h[1]!;
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) + (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0);
  }

  private finderTerminate(runColor: boolean, run: number, history: number[]): number {
    if (runColor) {
      this.finderHistoryAdd(run, history);
      run = 0;
    }
    run += this.size;
    this.finderHistoryAdd(run, history);
    return this.finderPenaltyCount(history);
  }

  private finderHistoryAdd(run: number, history: number[]): void {
    if (history[0] === 0) run += this.size;
    history.pop();
    history.unshift(run);
  }
}

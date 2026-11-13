// miniz_oxide 0.9.1's deflate compressor (`deflate::core`, derived from miniz's tdefl), as
// flate2 1.1.10 drives it for `Compression::default()`, plus flate2's gzip framing
// (`GzBuilder::new().mtime(0)`). hpy's bundle is hashed by HappyView, so the bytes must match
// Rust's exactly; Node's zlib makes different (equally valid) choices and can't be used.
//
// Only level 6 is ported: `create_comp_flags_from_zip_params(6, -15, 0)` is 128 probes, lazy
// matching, no zlib header, no RLE or filtering, so `compress_normal` is the only parser and
// `compress_fast` and `compress_stored` are left out. The output is a function of the input
// stream alone: tdefl only decides matches with a full 258-byte lookahead (or on finish), so
// how flate2 chunks its writes and sizes its output buffer doesn't change a byte. The oracle
// test checks that against Rust with chunked and whole writes.

const LZ_CODE_BUF_SIZE = 64 * 1024;
const OUT_BUF_SIZE = ((LZ_CODE_BUF_SIZE * 13) / 10) | 0;
const LZ_DICT_SIZE = 32_768;
const LZ_DICT_SIZE_MASK = LZ_DICT_SIZE - 1;
const MIN_MATCH_LEN = 3;
const MAX_MATCH_LEN = 258;
const LZ_DICT_FULL_SIZE = LZ_DICT_SIZE + MAX_MATCH_LEN - 1 + 1;
const LZ_HASH_BITS = 15;
const LZ_HASH_SHIFT = ((LZ_HASH_BITS + 2) / 3) | 0;
const LZ_HASH_SIZE = 1 << LZ_HASH_BITS;
const MAX_HUFF_SYMBOLS = 288;
const MAX_HUFF_SYMBOLS_0 = 288;
const MAX_HUFF_SYMBOLS_1 = 32;
const MAX_HUFF_SYMBOLS_2 = 19;
const LEN_SYM_OFFSET = 256;

const FLUSH_NONE = 0;
const FLUSH_FINISH = 4;

/** `NUM_PROBES[6]`, the probe count `Compression::default()` maps to. */
const LEVEL6_FLAGS = 128;

const fill = (n: number, runs: [number, number][]) => {
  const out = new Uint8Array(n);
  let i = 0;
  for (const [v, count] of runs) for (let k = 0; k < count; k++) out[i++] = v;
  return out;
};

const LEN_SYM = fill(256, [
  [1, 1],
  [2, 1],
  [3, 1],
  [4, 1],
  [5, 1],
  [6, 1],
  [7, 1],
  [8, 1],
  [9, 2],
  [10, 2],
  [11, 2],
  [12, 2],
  [13, 4],
  [14, 4],
  [15, 4],
  [16, 4],
  [17, 8],
  [18, 8],
  [19, 8],
  [20, 8],
  [21, 16],
  [22, 16],
  [23, 16],
  [24, 16],
  [25, 32],
  [26, 32],
  [27, 32],
  [28, 31],
  [29, 1],
]);

const LEN_EXTRA = fill(256, [
  [0, 8],
  [1, 8],
  [2, 16],
  [3, 32],
  [4, 64],
  [5, 127],
  [0, 1],
]);

const SMALL_DIST_SYM = fill(512, [
  [0, 1],
  [1, 1],
  [2, 1],
  [3, 1],
  [4, 2],
  [5, 2],
  [6, 4],
  [7, 4],
  [8, 8],
  [9, 8],
  [10, 16],
  [11, 16],
  [12, 32],
  [13, 32],
  [14, 64],
  [15, 64],
  [16, 128],
  [17, 128],
]);

const SMALL_DIST_EXTRA = fill(128, [
  [0, 1],
  [1, 1],
  [2, 2],
  [3, 4],
  [4, 8],
  [5, 16],
  [6, 32],
  [7, 64],
]);

const LARGE_DIST_SYM = fill(128, [
  [0, 2],
  [18, 1],
  [19, 1],
  [20, 2],
  [21, 2],
  [22, 4],
  [23, 4],
  [24, 8],
  [25, 8],
  [26, 16],
  [27, 16],
  [28, 32],
  [29, 32],
]);

const LARGE_DIST_EXTRA = fill(128, [
  [0, 2],
  [8, 2],
  [9, 4],
  [10, 8],
  [11, 16],
  [12, 32],
  [13, 64],
]);

const HUFFMAN_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** The bit writer: `OutputBufferOxide` and `BitBuffer`, which only ever append LSB-first. */
class Output {
  buf = new Uint8Array(OUT_BUF_SIZE * 2);
  pos = 0;
  bitBuffer = 0;
  bitsIn = 0;

  reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  putBits(bits: number, len: number): void {
    this.bitBuffer |= bits << this.bitsIn;
    this.bitsIn += len;
    while (this.bitsIn >= 8) {
      this.buf[this.pos++] = this.bitBuffer & 0xff;
      this.bitBuffer >>>= 8;
      this.bitsIn -= 8;
    }
  }

  padToBytes(): void {
    if (this.bitsIn !== 0) this.putBits(0, 8 - this.bitsIn);
  }

  writeBytes(src: Uint8Array): void {
    this.buf.set(src, this.pos);
    this.pos += src.length;
  }
}

/** `HuffmanOxide`: the three tables' symbol counts, codes and code lengths. */
class Huffman {
  count = [
    new Uint16Array(MAX_HUFF_SYMBOLS),
    new Uint16Array(MAX_HUFF_SYMBOLS),
    new Uint16Array(MAX_HUFF_SYMBOLS),
  ];
  codes = [
    new Uint16Array(MAX_HUFF_SYMBOLS),
    new Uint16Array(MAX_HUFF_SYMBOLS),
    new Uint16Array(MAX_HUFF_SYMBOLS),
  ];
  codeSizes = [
    new Uint8Array(MAX_HUFF_SYMBOLS),
    new Uint8Array(MAX_HUFF_SYMBOLS),
    new Uint8Array(MAX_HUFF_SYMBOLS),
  ];

  // Scratch for optimizeTable: keys and symbol indexes, two buffers for the radix sort.
  private k0 = new Uint16Array(MAX_HUFF_SYMBOLS);
  private s0 = new Uint16Array(MAX_HUFF_SYMBOLS);
  private k1 = new Uint16Array(MAX_HUFF_SYMBOLS);
  private s1 = new Uint16Array(MAX_HUFF_SYMBOLS);

  /** `radix_sort_symbols`: a stable two-pass (one if every key < 256) radix sort by key. */
  private radixSort(n: number): [Uint16Array, Uint16Array] {
    const hist0 = new Int32Array(256);
    const hist1 = new Int32Array(256);
    for (let i = 0; i < n; i++) {
      hist0[this.k0[i]! & 0xff]!++;
      hist1[(this.k0[i]! >> 8) & 0xff]!++;
    }
    const passes = n === hist1[0] ? 1 : 2;
    let ck = this.k0;
    let cs = this.s0;
    let nk = this.k1;
    let ns = this.s1;
    for (let pass = 0; pass < passes; pass++) {
      const hist = pass === 0 ? hist0 : hist1;
      const offsets = new Int32Array(256);
      let offset = 0;
      for (let i = 0; i < 256; i++) {
        offsets[i] = offset;
        offset += hist[i]!;
      }
      for (let i = 0; i < n; i++) {
        const j = (ck[i]! >> (pass * 8)) & 0xff;
        const at = offsets[j]!++;
        nk[at] = ck[i]!;
        ns[at] = cs[i]!;
      }
      [ck, nk] = [nk, ck];
      [cs, ns] = [ns, cs];
    }
    return [ck, cs];
  }

  /** `calculate_minimum_redundancy`: Moffat and Katajainen's in-place code lengths. */
  private static minimumRedundancy(key: Uint16Array, n: number): void {
    if (n === 0) return;
    if (n === 1) {
      key[0] = 1;
      return;
    }
    key[0] = key[0]! + key[1]!;
    let root = 0;
    let leaf = 2;
    for (let next = 1; next < n - 1; next++) {
      if (leaf >= n || key[root]! < key[leaf]!) {
        key[next] = key[root]!;
        key[root] = next;
        root++;
      } else {
        key[next] = key[leaf]!;
        leaf++;
      }
      if (leaf >= n || (root < next && key[root]! < key[leaf]!)) {
        key[next] = key[next]! + key[root]!;
        key[root] = next;
        root++;
      } else {
        key[next] = key[next]! + key[leaf]!;
        leaf++;
      }
    }
    key[n - 2] = 0;
    for (let next = n - 3; next >= 0; next--) key[next] = key[key[next]!]! + 1;
    let avbl = 1;
    let used = 0;
    let dpth = 0;
    let r = n - 2;
    let next = n - 1;
    while (avbl > 0) {
      while (r >= 0 && key[r] === dpth) {
        used++;
        r--;
      }
      while (avbl > used) {
        key[next] = dpth;
        next--;
        avbl--;
      }
      avbl = 2 * used;
      dpth++;
      used = 0;
    }
  }

  /** `enforce_max_code_size`. */
  private static enforceMaxCodeSize(numCodes: Int32Array, listLen: number, max: number): void {
    if (listLen <= 1) return;
    for (let i = max + 1; i < numCodes.length; i++) numCodes[max]! += numCodes[i]!;
    let total = 0;
    for (let i = max, shift = 0; i >= 1; i--, shift++)
      total = (total + (numCodes[i]! << shift)) >>> 0;
    for (let t = 1 << max; t < total; t++) {
      numCodes[max]!--;
      for (let i = max - 1; i >= 1; i--) {
        if (numCodes[i] !== 0) {
          numCodes[i]!--;
          numCodes[i + 1]! += 2;
          break;
        }
      }
    }
  }

  /** `optimize_table`. */
  optimizeTable(table: number, len: number, limit: number, staticTable: boolean): void {
    const numCodes = new Int32Array(33);
    const nextCode = new Uint32Array(16);
    const sizes = this.codeSizes[table]!;
    const codes = this.codes[table]!;
    if (staticTable) {
      for (let i = 0; i < len; i++) numCodes[sizes[i]!]!++;
    } else {
      const count = this.count[table]!;
      let used = 0;
      for (let i = 0; i < len; i++) {
        if (count[i] !== 0) {
          this.k0[used] = count[i]!;
          this.s0[used] = i;
          used++;
        }
      }
      const [key, sym] = this.radixSort(used);
      Huffman.minimumRedundancy(key, used);
      for (let i = 0; i < used; i++) numCodes[key[i]!]!++;
      Huffman.enforceMaxCodeSize(numCodes, used, limit);
      sizes.fill(0);
      codes.fill(0);
      let last = used;
      for (let i = 1; i <= limit; i++) {
        const first = last - numCodes[i]!;
        for (let s = first; s < last; s++) sizes[sym[s]!] = i;
        last = first;
      }
    }
    let j = 0;
    nextCode[1] = 0;
    for (let i = 2; i <= limit; i++) {
      j = (j + numCodes[i - 1]!) << 1;
      nextCode[i] = j;
    }
    for (let i = 0; i < len; i++) {
      const size = sizes[i]!;
      if (size === 0) continue;
      const code = nextCode[size]! & 0xffff;
      nextCode[size]!++;
      let rev = 0;
      for (let b = 0; b < 16; b++) rev |= ((code >> b) & 1) << (15 - b);
      codes[i] = rev >> (16 - size);
    }
  }

  startStaticBlock(out: Output): void {
    const lit = this.codeSizes[0]!;
    lit.fill(8, 0, 144);
    lit.fill(9, 144, 256);
    lit.fill(7, 256, 280);
    lit.fill(8, 280, 288);
    this.codeSizes[1]!.fill(5, 0, 32);
    this.optimizeTable(0, 288, 15, true);
    this.optimizeTable(1, 32, 15, true);
    out.putBits(0b01, 2);
  }

  startDynamicBlock(out: Output): void {
    this.count[0]![256] = 1;
    this.optimizeTable(0, MAX_HUFF_SYMBOLS_0, 15, false);
    this.optimizeTable(1, MAX_HUFF_SYMBOLS_1, 15, false);
    const lit = this.codeSizes[0]!;
    const dist = this.codeSizes[1]!;
    let numLit = 286;
    while (numLit > 257 && lit[numLit - 1] === 0) numLit--;
    let numDist = 30;
    while (numDist > 1 && dist[numDist - 1] === 0) numDist--;

    const toPack = new Uint8Array(MAX_HUFF_SYMBOLS_0 + MAX_HUFF_SYMBOLS_1);
    const packed = new Uint8Array(MAX_HUFF_SYMBOLS_0 + MAX_HUFF_SYMBOLS_1);
    const total = numLit + numDist;
    toPack.set(lit.subarray(0, numLit), 0);
    toPack.set(dist.subarray(0, numDist), numLit);

    const counts = this.count[2]!;
    counts.fill(0, 0, MAX_HUFF_SYMBOLS_2);
    let packedPos = 0;
    let zCount = 0;
    let repeatCount = 0;
    let prevCodeSize = 0xff;
    const flushRepeat = () => {
      if (repeatCount !== 0) {
        if (repeatCount < 3) {
          counts[prevCodeSize] = counts[prevCodeSize]! + repeatCount;
          for (let i = 0; i < repeatCount; i++) packed[packedPos++] = prevCodeSize;
        } else {
          counts[16] = counts[16]! + 1;
          packed[packedPos++] = 16;
          packed[packedPos++] = repeatCount - 3;
        }
        repeatCount = 0;
      }
    };
    const flushZeros = () => {
      if (zCount !== 0) {
        if (zCount < 3) {
          counts[0] = counts[0]! + zCount;
          for (let i = 0; i < zCount; i++) packed[packedPos++] = 0;
        } else if (zCount <= 10) {
          counts[17] = counts[17]! + 1;
          packed[packedPos++] = 17;
          packed[packedPos++] = zCount - 3;
        } else {
          counts[18] = counts[18]! + 1;
          packed[packedPos++] = 18;
          packed[packedPos++] = zCount - 11;
        }
        zCount = 0;
      }
    };
    for (let i = 0; i < total; i++) {
      const size = toPack[i]!;
      if (size === 0) {
        flushRepeat();
        zCount++;
        if (zCount === 138) flushZeros();
      } else {
        flushZeros();
        if (size !== prevCodeSize) {
          flushRepeat();
          counts[size] = counts[size]! + 1;
          packed[packedPos++] = size;
        } else {
          repeatCount++;
          if (repeatCount === 6) flushRepeat();
        }
      }
      prevCodeSize = size;
    }
    if (repeatCount !== 0) flushRepeat();
    else flushZeros();

    this.optimizeTable(2, MAX_HUFF_SYMBOLS_2, 7, false);

    out.putBits(2, 2);
    out.putBits(numLit - 257, 5);
    out.putBits(numDist - 1, 5);
    const cl = this.codeSizes[2]!;
    let numBitLengths = 18;
    while (numBitLengths >= 0 && cl[HUFFMAN_LENGTH_ORDER[numBitLengths]!] === 0) numBitLengths--;
    // `18 - (trailing zeros)`, then at least 4 and one more for the count itself.
    numBitLengths = Math.max(4, numBitLengths + 1);
    out.putBits(numBitLengths - 4, 4);
    for (let i = 0; i < numBitLengths; i++) out.putBits(cl[HUFFMAN_LENGTH_ORDER[i]!]!, 3);
    const clCodes = this.codes[2]!;
    for (let i = 0; i < packedPos; ) {
      const code = packed[i++]!;
      out.putBits(clCodes[code]!, cl[code]!);
      if (code >= 16) out.putBits(packed[i++]!, [2, 3, 7][code - 16]!);
    }
  }
}

/** `crc32fast`, the IEEE CRC-32 gzip's trailer carries. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * A raw deflate stream at `Compression::default()`, byte-for-byte as flate2 1.1.10 with
 * miniz_oxide 0.9.1 writes it. `write` any number of chunks, then `finish` once.
 */
export class Deflater {
  // DictOxide
  private dict = new Uint8Array(LZ_DICT_FULL_SIZE);
  private next = new Uint16Array(LZ_DICT_SIZE);
  private hash = new Uint16Array(LZ_HASH_SIZE);
  private maxProbes0 = 1 + Math.floor(((LEVEL6_FLAGS & 0xfff) + 2) / 3);
  private maxProbes1 = 1 + Math.floor((((LEVEL6_FLAGS & 0xfff) >> 2) + 2) / 3);
  private codeBufDictPos = 0;
  private lookaheadSize = 0;
  private lookaheadPos = 0;
  private dictSize = 0;
  // LZOxide
  private codes = new Uint8Array(LZ_CODE_BUF_SIZE);
  private codePosition = 1;
  private flagPosition = 0;
  private totalBytes = 0;
  private numFlagsLeft = 8;
  // ParamsOxide
  private savedMatchDist = 0;
  private savedMatchLen = 0;
  private savedLit = 0;
  private flush = FLUSH_NONE;
  private finished = false;

  private huff = new Huffman();
  private out = new Output();
  private chunks: Uint8Array[] = [];

  write(data: Uint8Array): void {
    if (this.finished) throw new Error("write after finish");
    this.flush = FLUSH_NONE;
    this.compressNormal(data);
    this.drain();
  }

  finish(): Uint8Array {
    if (!this.finished) {
      this.flush = FLUSH_FINISH;
      this.compressNormal(new Uint8Array(0));
      this.flushBlock(FLUSH_FINISH);
      this.finished = true;
      this.drain();
    }
    return concat(this.chunks);
  }

  /** Moves the whole bytes written so far out, keeping the partial byte's bits. */
  private drain(): void {
    const out = this.out;
    if (out.pos === 0) return;
    this.chunks.push(out.buf.slice(0, out.pos));
    out.pos = 0;
  }

  private u16(pos: number): number {
    return this.dict[pos]! | (this.dict[pos + 1]! << 8);
  }

  /** `DictOxide::find_match`. Returns the match in `matchDist` / `matchLen`. */
  private foundDist = 0;
  private foundLen = 0;
  private findMatch(
    lookaheadPos: number,
    maxDist: number,
    maxMatchLenIn: number,
    matchDistIn: number,
    matchLenIn: number,
  ): void {
    const dict = this.dict;
    const nextArr = this.next;
    const maxMatchLen = Math.min(MAX_MATCH_LEN, maxMatchLenIn);
    let matchDist = matchDistIn;
    let matchLen = Math.max(matchLenIn, 1);
    this.foundDist = matchDist;
    this.foundLen = matchLen;
    if (maxMatchLen <= matchLen) return;
    const pos = lookaheadPos & LZ_DICT_SIZE_MASK;
    let probePos = pos;
    let probesLeft = matchLen < 32 ? this.maxProbes0 : this.maxProbes1;
    let c01 = this.u16(pos + matchLen - 1);
    const s01 = this.u16(pos);
    outer: for (;;) {
      let dist = 0;
      found: for (;;) {
        probesLeft--;
        if (probesLeft === 0) {
          this.foundDist = matchDist;
          this.foundLen = matchLen;
          return;
        }
        for (let k = 0; k < 3; k++) {
          const nextProbe = nextArr[probePos]!;
          dist = (lookaheadPos - nextProbe) & 0xffff;
          if (nextProbe === 0 || dist > maxDist || matchLen - 1 >= MAX_MATCH_LEN) {
            this.foundDist = matchDist;
            this.foundLen = matchLen;
            return;
          }
          probePos = nextProbe & LZ_DICT_SIZE_MASK;
          if (this.u16(probePos + matchLen - 1) === c01) break found;
        }
      }
      if (dist === 0) {
        this.foundDist = matchDist;
        this.foundLen = matchLen;
        return;
      }
      if (this.u16(probePos) !== s01) continue;
      let p = pos + 2;
      let q = probePos + 2;
      for (let n = 0; n < 32; n++) {
        // `read_unaligned_u64` at each (masked) position, compared a byte at a time.
        const pm = p & LZ_DICT_SIZE_MASK;
        const qm = q & LZ_DICT_SIZE_MASK;
        let k = 0;
        while (k < 8 && dict[pm + k] === dict[qm + k]) k++;
        if (k === 8) {
          p += 8;
          q += 8;
          continue;
        }
        const probeLen = p - pos + k;
        if (probeLen > matchLen) {
          matchDist = dist;
          matchLen = Math.min(maxMatchLen, probeLen);
          if (matchLen >= maxMatchLen) {
            this.foundDist = matchDist;
            this.foundLen = matchLen;
            return;
          }
          c01 = this.u16(Math.max(pos + matchLen - 1, 0));
        }
        continue outer;
      }
      this.foundDist = dist;
      this.foundLen = Math.min(maxMatchLen, MAX_MATCH_LEN);
      return;
    }
  }

  private writeCode(v: number): void {
    this.codes[this.codePosition & 0xffff] = v;
    this.codePosition++;
  }

  private consumeFlag(): void {
    this.numFlagsLeft--;
    if (this.numFlagsLeft === 0) {
      this.numFlagsLeft = 8;
      this.flagPosition = this.codePosition;
      this.codePosition++;
    }
  }

  private recordLiteral(lit: number): void {
    this.totalBytes++;
    this.writeCode(lit);
    const f = this.flagPosition & 0xffff;
    this.codes[f] = this.codes[f]! >> 1;
    this.consumeFlag();
    this.huff.count[0]![lit]!++;
  }

  private recordMatch(len: number, distIn: number): void {
    this.totalBytes += len;
    const dist = distIn - 1;
    const l = (len - MIN_MATCH_LEN) & 0xff;
    this.writeCode(l);
    this.writeCode(dist & 0xff);
    this.writeCode((dist >> 8) & 0xff);
    const f = this.flagPosition & 0xffff;
    this.codes[f] = (this.codes[f]! >> 1) | 0x80;
    this.consumeFlag();
    const sym = dist < 512 ? SMALL_DIST_SYM[dist]! : LARGE_DIST_SYM[(dist >> 8) & 127]!;
    this.huff.count[1]![sym]!++;
    this.huff.count[0]![(LEN_SYM[l]! & 31) + LEN_SYM_OFFSET]!++;
  }

  /** `compress_normal`: lazy matching over the lookahead window. */
  private compressNormal(inBuf: Uint8Array): void {
    const dict = this.dict;
    const nextArr = this.next;
    const hashArr = this.hash;
    let srcPos = 0;
    let lookaheadSize = this.lookaheadSize;
    let lookaheadPos = this.lookaheadPos;
    let savedLit = this.savedLit;
    let savedMatchDist = this.savedMatchDist;
    let savedMatchLen = this.savedMatchLen;
    const mask = LZ_HASH_SIZE - 1;

    while (srcPos < inBuf.length || (this.flush !== FLUSH_NONE && lookaheadSize !== 0)) {
      const num = Math.min(inBuf.length - srcPos, MAX_MATCH_LEN - lookaheadSize);
      if (lookaheadSize + this.dictSize >= MIN_MATCH_LEN - 1 && num > 0) {
        let dstPos = (lookaheadPos + lookaheadSize) & LZ_DICT_SIZE_MASK;
        let insPos = lookaheadPos + lookaheadSize - 2;
        let hash =
          ((dict[insPos & LZ_DICT_SIZE_MASK]! << LZ_HASH_SHIFT) ^
            dict[(insPos + 1) & LZ_DICT_SIZE_MASK]!) &
          mask;
        lookaheadSize += num;
        for (let i = 0; i < num; i++) {
          const c = inBuf[srcPos + i]!;
          dict[dstPos] = c;
          if (dstPos < MAX_MATCH_LEN - 1) dict[LZ_DICT_SIZE + dstPos] = c;
          hash = ((hash << LZ_HASH_SHIFT) ^ c) & mask;
          nextArr[insPos & LZ_DICT_SIZE_MASK] = hashArr[hash]!;
          hashArr[hash] = insPos & 0xffff;
          dstPos = (dstPos + 1) & LZ_DICT_SIZE_MASK;
          insPos++;
        }
        srcPos += num;
      } else {
        for (let i = 0; i < num; i++) {
          const c = inBuf[srcPos + i]!;
          const dstPos = (lookaheadPos + lookaheadSize) & LZ_DICT_SIZE_MASK;
          dict[dstPos] = c;
          if (dstPos < MAX_MATCH_LEN - 1) dict[LZ_DICT_SIZE + dstPos] = c;
          lookaheadSize++;
          if (lookaheadSize + this.dictSize >= MIN_MATCH_LEN) {
            const insPos = lookaheadPos + lookaheadSize - 3;
            const hash =
              ((dict[insPos & LZ_DICT_SIZE_MASK]! << (LZ_HASH_SHIFT * 2)) ^
                ((dict[(insPos + 1) & LZ_DICT_SIZE_MASK]! << LZ_HASH_SHIFT) ^ c)) &
              mask;
            nextArr[insPos & LZ_DICT_SIZE_MASK] = hashArr[hash]!;
            hashArr[hash] = insPos & 0xffff;
          }
        }
        srcPos += num;
      }

      this.dictSize = Math.min(LZ_DICT_SIZE - lookaheadSize, this.dictSize);
      if (this.flush === FLUSH_NONE && lookaheadSize < MAX_MATCH_LEN) break;

      let lenToMove = 1;
      const curPos = lookaheadPos & LZ_DICT_SIZE_MASK;
      this.findMatch(
        lookaheadPos,
        this.dictSize,
        lookaheadSize,
        0,
        savedMatchLen !== 0 ? savedMatchLen : MIN_MATCH_LEN - 1,
      );
      let curMatchDist = this.foundDist;
      let curMatchLen = this.foundLen;

      const farAndSmall = curMatchLen === MIN_MATCH_LEN && curMatchDist >= 8 * 1024;
      if (farAndSmall || curPos === curMatchDist) {
        curMatchDist = 0;
        curMatchLen = 0;
      }

      if (savedMatchLen !== 0) {
        if (curMatchLen > savedMatchLen) {
          this.recordLiteral(savedLit);
          if (curMatchLen >= 128) {
            this.recordMatch(curMatchLen, curMatchDist);
            savedMatchLen = 0;
            lenToMove = curMatchLen;
          } else {
            savedLit = dict[curPos]!;
            savedMatchDist = curMatchDist;
            savedMatchLen = curMatchLen;
          }
        } else {
          this.recordMatch(savedMatchLen, savedMatchDist);
          lenToMove = savedMatchLen - 1;
          savedMatchLen = 0;
        }
      } else if (curMatchDist === 0) {
        this.recordLiteral(dict[Math.min(curPos, LZ_DICT_FULL_SIZE - 1)]!);
      } else if (curMatchLen >= 128) {
        this.recordMatch(curMatchLen, curMatchDist);
        lenToMove = curMatchLen;
      } else {
        savedLit = dict[Math.min(curPos, LZ_DICT_FULL_SIZE - 1)]!;
        savedMatchDist = curMatchDist;
        savedMatchLen = curMatchLen;
      }

      lookaheadPos += lenToMove;
      lookaheadSize -= lenToMove;
      this.dictSize = Math.min(this.dictSize + lenToMove, LZ_DICT_SIZE);

      const tight = this.codePosition > LZ_CODE_BUF_SIZE - 8;
      const fat = (this.codePosition * 115) >> 7 >= this.totalBytes;
      if (tight || (this.totalBytes > 31 * 1024 && fat)) {
        this.lookaheadSize = lookaheadSize;
        this.lookaheadPos = lookaheadPos;
        // Output is never short here, so `flush_block` always reports nothing remaining.
        this.flushBlock(FLUSH_NONE);
      }
    }

    this.lookaheadSize = lookaheadSize;
    this.lookaheadPos = lookaheadPos;
    this.savedLit = savedLit;
    this.savedMatchDist = savedMatchDist;
    this.savedMatchLen = savedMatchLen;
  }

  /** `compress_lz_codes`: the buffered literals and matches, then end-of-block. */
  private compressLzCodes(): void {
    const out = this.out;
    const buf = this.codes;
    const used = Math.min(LZ_CODE_BUF_SIZE, this.codePosition);
    const litCodes = this.huff.codes[0]!;
    const litSizes = this.huff.codeSizes[0]!;
    const distCodes = this.huff.codes[1]!;
    const distSizes = this.huff.codeSizes[1]!;
    let flags = 1;
    let i = 0;
    while (i < used) {
      if (flags === 1) {
        flags = buf[i]! | 0x100;
        i++;
      }
      if (flags & 1) {
        flags >>= 1;
        const matchLen = buf[i & 0xffff]!;
        const matchDist = buf[(i + 1) & 0xffff]! | (buf[(i + 2) & 0xffff]! << 8);
        i += 3;
        const lenSym = (LEN_SYM[matchLen]! & 31) + LEN_SYM_OFFSET;
        out.putBits(litCodes[lenSym]!, litSizes[lenSym]!);
        const lenExtra = LEN_EXTRA[matchLen]!;
        out.putBits(matchLen & ((1 << (lenExtra & 7)) - 1), lenExtra);
        let sym: number;
        let extra: number;
        if (matchDist < 512) {
          sym = SMALL_DIST_SYM[matchDist]!;
          extra = SMALL_DIST_EXTRA[matchDist >> 2]!;
        } else {
          sym = LARGE_DIST_SYM[matchDist >> 8]!;
          extra = LARGE_DIST_EXTRA[matchDist >> 8]!;
        }
        out.putBits(distCodes[sym]!, distSizes[sym]!);
        out.putBits(matchDist & ((1 << (extra & 15)) - 1), extra);
      } else {
        for (let k = 0; k < 3; k++) {
          flags >>= 1;
          const lit = buf[i & 0xffff]!;
          i++;
          out.putBits(litCodes[lit]!, litSizes[lit]!);
          if (flags & 1 || i >= used) break;
        }
      }
    }
    out.putBits(litCodes[256]!, litSizes[256]!);
  }

  private compressBlock(staticBlock: boolean): void {
    if (staticBlock) this.huff.startStaticBlock(this.out);
    else this.huff.startDynamicBlock(this.out);
    this.compressLzCodes();
  }

  /** `flush_block`: one deflate block (dynamic, static, or stored when it would expand). */
  private flushBlock(flush: number): void {
    const out = this.out;
    out.reserve(OUT_BUF_SIZE * 2 + this.totalBytes);
    if (this.totalBytes > 0 || flush === FLUSH_FINISH) {
      // init_flag
      if (this.numFlagsLeft === 8) {
        this.codes[this.flagPosition & 0xffff] = 0;
        this.codePosition--;
      } else {
        const f = this.flagPosition & 0xffff;
        this.codes[f] = this.codes[f]! >> this.numFlagsLeft;
      }
      out.putBits(flush === FLUSH_FINISH ? 1 : 0, 1);
      const savedPos = out.pos;
      const savedBits = out.bitBuffer;
      const savedBitsIn = out.bitsIn;

      this.compressBlock(this.totalBytes < 48);

      const expanded =
        this.totalBytes > 32 &&
        out.pos - savedPos + 1 >= this.totalBytes &&
        this.lookaheadPos - this.codeBufDictPos <= this.dictSize;
      if (expanded) {
        out.pos = savedPos;
        out.bitBuffer = savedBits;
        out.bitsIn = savedBitsIn;
        out.putBits(0, 2);
        out.padToBytes();
        out.putBits(this.totalBytes & 0xffff, 16);
        out.putBits(~this.totalBytes & 0xffff, 16);
        const start = this.codeBufDictPos & LZ_DICT_SIZE_MASK;
        const end = (this.codeBufDictPos + this.totalBytes) & LZ_DICT_SIZE_MASK;
        if (start < end) {
          out.writeBytes(this.dict.subarray(start, end));
        } else if (this.totalBytes > 0) {
          out.writeBytes(this.dict.subarray(start, LZ_DICT_SIZE));
          out.writeBytes(this.dict.subarray(0, end));
        }
      }
    }
    if (flush === FLUSH_FINISH) out.padToBytes();

    this.huff.count[0]!.fill(0, 0, MAX_HUFF_SYMBOLS_0);
    this.huff.count[1]!.fill(0, 0, MAX_HUFF_SYMBOLS_1);
    this.codePosition = 1;
    this.flagPosition = 0;
    this.numFlagsLeft = 8;
    this.codeBufDictPos += this.totalBytes;
    this.totalBytes = 0;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** `DeflateEncoder::new(_, Compression::default())`, all at once. */
export function deflateRaw(data: Uint8Array): Uint8Array {
  const d = new Deflater();
  d.write(data);
  return d.finish();
}

/**
 * `GzBuilder::new().mtime(0).write(_, Compression::default())`: a 10-byte header with no
 * flags, mtime 0, XFL 0 (level 6 is neither `best` nor `fast`) and OS 255 (unknown), the
 * deflate stream, then the CRC-32 and the length mod 2^32, little-endian.
 */
export class GzipWriter {
  private deflater = new Deflater();
  private crc = 0;
  private amount = 0;

  write(data: Uint8Array): void {
    this.crc = crc32(data, this.crc);
    this.amount = (this.amount + data.length) >>> 0;
    this.deflater.write(data);
  }

  finish(): Uint8Array {
    const body = this.deflater.finish();
    const out = new Uint8Array(10 + body.length + 8);
    out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255], 0);
    out.set(body, 10);
    const t = new DataView(out.buffer, 10 + body.length, 8);
    t.setUint32(0, this.crc, true);
    t.setUint32(4, this.amount, true);
    return out;
  }
}

export function gzip(data: Uint8Array): Uint8Array {
  const g = new GzipWriter();
  g.write(data);
  return g.finish();
}

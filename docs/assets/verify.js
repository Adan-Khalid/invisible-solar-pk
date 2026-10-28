// Pure helpers behind "Verify it yourself": hashing and the tamper demo.
// No DOM and no network, so they run unchanged in the browser and in Node
// (unit tests: `node docs/assets/verify.test.mjs`).

const encoder = new TextEncoder();

/** Bytes of a string (UTF-8), ArrayBuffer or typed array, without copying views. */
export function toBytes(input) {
  if (typeof input === "string") return encoder.encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("sha256Hex expects a string, ArrayBuffer or typed array");
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Lower-case hex SHA-256 of `input` (text is hashed as UTF-8). Uses WebCrypto when the page
 * runs in a secure context (https or localhost); falls back to the pure-JS version otherwise.
 */
export async function sha256Hex(input) {
  const bytes = toBytes(input);
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) return toHex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
  return sha256HexSync(bytes);
}

// FIPS 180-4 round constants.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** Synchronous pure-JS SHA-256 (fallback for insecure contexts where crypto.subtle is absent). */
export function sha256HexSync(input) {
  const bytes = toBytes(input);
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000)); // bit length, high word
  view.setUint32(padded.length - 4, (len << 3) >>> 0); // bit length, low word

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = W[i - 16] + s0 + W[i - 7] + s1; // Uint32Array wraps mod 2^32
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d;
    H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (w) => w.toString(16).padStart(8, "0")).join("");
}

/** "0xABC..." or "abc..." -> "abc..." (lower case, no prefix). */
export function normalizeHash(hash) {
  return String(hash || "").trim().toLowerCase().replace(/^0x/, "");
}

/** True when two hex hashes are equal, ignoring case and a 0x prefix. Empty never matches. */
export function hashesEqual(a, b) {
  const x = normalizeHash(a);
  return x.length > 0 && x === normalizeHash(b);
}

/** "20ef0e1a2e44…3b46d8cc25" style shortening for tables; full value stays in a title/copy. */
export function shortHash(hash, head = 8, tail = 6) {
  const h = normalizeHash(hash);
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** Number of lines in the file (a trailing LF does not start a new line). */
export function countLines(csvText) {
  if (!csvText) return 0;
  const n = csvText.split("\n").length;
  return csvText.endsWith("\n") ? n - 1 : n;
}

/** 1-based line number of the middle data row (line 1 is the header): a deterministic demo target. */
export function middleDataLine(csvText) {
  const lines = countLines(csvText);
  if (lines < 2) throw new RangeError("file has no data rows");
  return 2 + Math.floor((lines - 1) / 2);
}

/**
 * Demo target: the first row at or after the middle of the file whose timestamp is `hh:mm`
 * (midday by default, when rooftop PV is hidden in the net load). Falls back to the middle row.
 */
export function demoTamperLine(csvText, hhmm = "12:00") {
  const start = middleDataLine(csvText);
  const lines = csvText.split("\n");
  for (let n = start; n <= Math.min(start + 48, countLines(csvText)); n++) {
    if (lines[n - 1].split(",")[0].endsWith(`T${hhmm}`)) return n;
  }
  return start;
}

/** 1-based line number of the data row stamped `stamp` (e.g. "2024-01-01T13:00"), or null. */
export function lineOfTimestamp(csvText, stamp) {
  const lines = String(csvText).split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith(`${stamp},`)) return i + 1;
  }
  return null;
}

/**
 * Add `deltaMw` to one reading of `column` on 1-based `lineNo`, keeping every other byte and
 * the value's decimal places unchanged. Returns the new text plus what changed. Pure: the
 * input string is not modified.
 */
export function tamperOneReading(csvText, lineNo, deltaMw = 1, column = "net_load_mw") {
  if (typeof csvText !== "string") throw new TypeError("csvText must be a string");
  if (!Number.isFinite(deltaMw) || deltaMw === 0) throw new RangeError("deltaMw must be a non-zero number");
  const lines = csvText.split("\n");
  const col = lines[0].replace(/\r$/, "").split(",").indexOf(column);
  if (col < 0) throw new Error(`no "${column}" column in the header`);
  if (!Number.isInteger(lineNo) || lineNo < 2 || lineNo > countLines(csvText)) {
    throw new RangeError(`line ${lineNo} is not a data row`);
  }
  const before = lines[lineNo - 1];
  const cells = before.split(",");
  const raw = cells[col];
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value)) {
    throw new Error(`line ${lineNo} has no numeric ${column}`);
  }
  const decimals = (raw.split(".")[1] || "").length;
  const newValue = (value + deltaMw).toFixed(decimals);
  const after = cells.map((cell, i) => (i === col ? newValue : cell)).join(",");
  return {
    text: lines.map((line, i) => (i === lineNo - 1 ? after : line)).join("\n"),
    lineNo,
    column,
    timestamp: cells[0],
    before,
    after,
    oldValue: raw,
    newValue,
  };
}

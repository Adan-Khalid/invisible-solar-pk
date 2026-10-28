// Unit tests for docs/assets/verify.js against the real evidence bundles and their manifest.
// Run from anywhere: node docs/assets/verify.test.mjs   (Node >= 18, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  sha256Hex, sha256HexSync, tamperOneReading, middleDataLine, demoTamperLine, lineOfTimestamp, countLines,
  hashesEqual, normalizeHash, shortHash,
} from "./verify.js";
import { safeHttps, explorerUrl, resolveLinks, isPlaceholder } from "./links.js";
import { REGISTRY_ABI, STATUS_NAMES, referenceRecord } from "./registry.js";

const docs = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const repo = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const readJsonIf = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);
const manifest = JSON.parse(readFileSync(docs("data/manifest.json"), "utf8"));
const site = JSON.parse(readFileSync(docs("data/site.json"), "utf8"));
const validation = JSON.parse(readFileSync(docs("assets/validation.json"), "utf8"));
const deployment = readJsonIf(docs("data/deployment.json"));
// Same row as TAMPER_STAMP in app.js and TAMPER_TS in chain/scripts/demo.js (checked below).
const TAMPER_STAMP = "2024-01-01T13:00";
const bundles = manifest.attestations.map((a) => {
  const bytes = readFileSync(docs(`evidence/${a.evidence_file}`));
  return { ...a, bytes, text: bytes.toString("utf8") };
});

test("manifest lists the four AEMO regions", () => {
  assert.deepEqual(manifest.attestations.map((a) => a.station), ["AEMO/NSW1", "AEMO/QLD1", "AEMO/VIC1", "AEMO/SA1"]);
});

for (const b of bundles) {
  test(`${b.station}: browser hash of the published file equals the anchored manifest hash`, async () => {
    assert.equal(await sha256Hex(b.bytes), b.evidence_sha256);
    assert.equal(await sha256Hex(b.bytes.buffer.slice(b.bytes.byteOffset, b.bytes.byteOffset + b.bytes.length)), b.evidence_sha256);
  });

  test(`${b.station}: hashing the decoded text gives the same digest as hashing the bytes`, async () => {
    assert.equal(await sha256Hex(b.text), b.evidence_sha256);
  });

  test(`${b.station}: pure-JS fallback agrees with WebCrypto and node:crypto`, () => {
    assert.equal(sha256HexSync(b.bytes), b.evidence_sha256);
    assert.equal(createHash("sha256").update(b.bytes).digest("hex"), b.evidence_sha256);
  });

  test(`${b.station}: file is LF-only with the v1 header and n_hours data rows`, () => {
    assert.ok(!b.text.includes("\r"), "evidence must not contain CR");
    assert.ok(b.text.startsWith("timestamp,net_load_mw,ghi_wm2,t2m_c,rooftop_pv_mw_measured\n"));
    assert.equal(countLines(b.text) - 1, b.n_hours);
  });

  test(`${b.station}: site.json carries the same evidence hash as the manifest`, () => {
    const region = site.regions.find((r) => r.station === b.station);
    assert.ok(region, "region present in site.json");
    assert.equal(region.evidence_sha256, b.evidence_sha256);
    assert.equal(region.evidence_file, b.evidence_file);
  });

  test(`${b.station}: +1 MW on one reading changes exactly one line and breaks the hash`, async () => {
    const line = middleDataLine(b.text);
    const t = tamperOneReading(b.text, line, 1);
    const oldLines = b.text.split("\n");
    const newLines = t.text.split("\n");
    assert.equal(newLines.length, oldLines.length);
    const changed = newLines.flatMap((l, i) => (l === oldLines[i] ? [] : [i + 1]));
    assert.deepEqual(changed, [line]);
    assert.equal(t.before, oldLines[line - 1]);
    assert.equal(t.after, newLines[line - 1]);
    assert.equal((Number(t.newValue) - Number(t.oldValue)).toFixed(3), "1.000");
    assert.equal(t.newValue.split(".")[1].length, 3, "keeps three decimals");
    // other columns of the tampered row are untouched
    const [bc, ac] = [t.before.split(","), t.after.split(",")];
    assert.deepEqual(ac.filter((_, i) => i !== 1), bc.filter((_, i) => i !== 1));

    const tampered = await sha256Hex(t.text);
    assert.notEqual(tampered, b.evidence_sha256);
    assert.equal(tampered, createHash("sha256").update(t.text, "utf8").digest("hex"));
    // undoing the edit restores the anchored hash
    assert.equal(await sha256Hex(tamperOneReading(t.text, line, -1).text), b.evidence_sha256);
  });
}

test("demoTamperLine picks a midday row near the middle of each real file", () => {
  for (const b of bundles) {
    const line = demoTamperLine(b.text);
    assert.ok(line >= middleDataLine(b.text) && line <= middleDataLine(b.text) + 48);
    assert.match(b.text.split("\n")[line - 1], /^2024-\d\d-\d\dT12:00,/);
  }
  const noNoon = "timestamp,net_load_mw\n2024-01-01T00:00,1.000\n2024-01-01T01:00,2.000\n";
  assert.equal(demoTamperLine(noNoon), middleDataLine(noNoon));
});

test("tamperOneReading leaves the input string untouched and reports what changed", () => {
  const csv = "timestamp,net_load_mw,ghi_wm2\n2024-01-01T12:00,7123.456,812.300\n2024-01-01T13:00,-206.500,0.000\n";
  const t = tamperOneReading(csv, 3, 1);
  assert.equal(t.before, "2024-01-01T13:00,-206.500,0.000");
  assert.equal(t.after, "2024-01-01T13:00,-205.500,0.000");
  assert.equal(t.timestamp, "2024-01-01T13:00");
  assert.equal(t.oldValue, "-206.500");
  assert.equal(t.newValue, "-205.500");
  assert.ok(csv.includes("-206.500"));
  assert.ok(t.text.endsWith("\n"));
});

test("tamperOneReading rejects the header, out-of-range lines and a zero delta", () => {
  const csv = "timestamp,net_load_mw\n2024-01-01T00:00,1.000\n";
  assert.throws(() => tamperOneReading(csv, 1, 1), RangeError);
  assert.throws(() => tamperOneReading(csv, 3, 1), RangeError);
  assert.throws(() => tamperOneReading(csv, 2, 0), RangeError);
  assert.throws(() => tamperOneReading("a,b\n1,2\n", 2, 1), /no "net_load_mw" column/);
  assert.throws(() => tamperOneReading("timestamp,net_load_mw\n2024,\n", 2, 1), /no numeric/);
});

test("SHA-256 known-answer vectors (FIPS 180-4) for both code paths", async () => {
  const vectors = {
    "": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    abc: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq":
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  };
  for (const [msg, want] of Object.entries(vectors)) {
    assert.equal(await sha256Hex(msg), want);
    assert.equal(sha256HexSync(msg), want);
  }
  // padding edge cases: 55, 56, 63, 64 and 65 bytes
  for (const n of [55, 56, 63, 64, 65, 1000]) {
    const msg = "x".repeat(n);
    assert.equal(sha256HexSync(msg), createHash("sha256").update(msg).digest("hex"), `length ${n}`);
  }
});

test("hash helpers normalise case and 0x prefixes", () => {
  const h = manifest.attestations[0].evidence_sha256;
  assert.equal(normalizeHash(`0x${h.toUpperCase()}`), h);
  assert.ok(hashesEqual(`0x${h}`, h.toUpperCase()));
  assert.ok(!hashesEqual("", ""));
  assert.equal(shortHash(h), `${h.slice(0, 8)}…${h.slice(-6)}`);
  assert.throws(() => sha256HexSync(42), TypeError);
});

test("lineOfTimestamp finds a data row by its stamp and never matches the header", () => {
  const csv = "timestamp,net_load_mw\n2024-01-01T12:00,1.000\n2024-01-01T13:00,2.000\n";
  assert.equal(lineOfTimestamp(csv, "2024-01-01T13:00"), 3);
  assert.equal(lineOfTimestamp(csv, "2024-01-01T14:00"), null);
  assert.equal(lineOfTimestamp(csv, "timestamp"), null);
  for (const b of bundles) {
    const n = lineOfTimestamp(b.text, TAMPER_STAMP);
    assert.ok(n >= 2 && n <= 20, `${b.station}: ${TAMPER_STAMP} is near the top of the file`);
    assert.ok(b.text.split("\n")[n - 1].startsWith(`${TAMPER_STAMP},`));
  }
});

test("the page's tamper row is the chain demo's TAMPER_TS", () => {
  const app = readFileSync(docs("assets/app.js"), "utf8");
  assert.match(app, new RegExp(`const TAMPER_STAMP = "${TAMPER_STAMP}";`));
  const demoPath = repo("chain/scripts/demo.js");
  if (existsSync(demoPath)) assert.match(readFileSync(demoPath, "utf8"), new RegExp(`const TAMPER_TS = "${TAMPER_STAMP}";`));
});

test("tampering NSW in the browser reproduces the evidence hash of the chain demo's Disputed record", async (t) => {
  const disputed = (deployment?.attestations || []).filter((a) => a.station === "AEMO/NSW1" && a.status === "Disputed");
  if (!disputed.length) return t.skip("no Disputed NSW record in docs/data/deployment.json");
  const nsw = bundles.find((b) => b.station === "AEMO/NSW1");
  const edited = tamperOneReading(nsw.text, lineOfTimestamp(nsw.text, TAMPER_STAMP), 1);
  assert.equal(edited.before, "2024-01-01T13:00,6020.738,416.230,23.900,2033.479");
  const hex = await sha256Hex(edited.text);
  assert.ok(disputed.some((a) => hashesEqual(a.evidenceSha256, hex)), `expected a Disputed record with hash ${hex}`);
});

test("validation.json copies the IRR-hourly and naive rows of the results table verbatim", (t) => {
  const csvPath = repo("results/tables/m1_multiregion_nem.csv");
  if (!existsSync(csvPath)) return t.skip("results table not present (docs copied on its own)");
  const [head, ...lines] = readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
  assert.deepEqual(Object.keys(validation.regions), manifest.attestations.map((a) => a.station));
  for (const [station, v] of Object.entries(validation.regions)) {
    const region = station.split("/")[1];
    const irr = rows.find((r) => r.region === region && r.method === "IRR hourly");
    const naive = rows.find((r) => r.region === region && r.method.startsWith("Naive"));
    for (const k of ["recovery_full_pct", "corr_full", "corr_daylight_full", "recovery_oddeven_pct", "corr_oddeven"]) {
      assert.equal(v[k], Number(irr[k]), `${station} ${k}`);
    }
    assert.equal(v.naive_recovery_full_pct, Number(naive.recovery_full_pct), `${station} naive`);
  }
});

// ---------------------------------------------------------------- links, registry reads, page hygiene

/** ethers v6 from the repo's node_modules (Hardhat toolbox), or null when docs/ is checked on its own. */
async function loadEthers() {
  try {
    return await import("ethers");
  } catch {
    return null;
  }
}

test("safeHttps links only absolute https:// URLs without credentials", () => {
  assert.equal(safeHttps("https://github.com/someone/invisible-solar-pk"), "https://github.com/someone/invisible-solar-pk");
  assert.equal(safeHttps("  https://youtu.be/abc123 "), "https://youtu.be/abc123");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>",
    "http://example.org", "//example.org", "/relative", "https://", "https://user:pw@example.org", "", null, undefined, 42]) {
    assert.equal(safeHttps(bad), "", String(bad));
  }
});

test("explorerUrl joins an https base with a 0x id and refuses anything else", () => {
  const tx = `0x${"ab".repeat(32)}`;
  assert.equal(explorerUrl("https://sepolia.etherscan.io", "tx", tx), `https://sepolia.etherscan.io/tx/${tx}`);
  assert.equal(explorerUrl("https://sepolia.etherscan.io/", "address", "0x5FbDB2315678afecb367f032d93F642f64180aa3"),
    "https://sepolia.etherscan.io/address/0x5FbDB2315678afecb367f032d93F642f64180aa3");
  assert.equal(explorerUrl(null, "tx", tx), "");
  assert.equal(explorerUrl("javascript:alert(1)//", "tx", tx), "");
  assert.equal(explorerUrl("https://sepolia.etherscan.io", "tx", "\"><script>"), "");
  assert.equal(explorerUrl("https://sepolia.etherscan.io", "tx", undefined), "");
});

test("resolveLinks hides placeholders and non-https values and infers the repo on github.io", () => {
  const placeholder = "https://github.com/<your-github-username>/invisible-solar-pk";
  assert.ok(isPlaceholder(placeholder) && isPlaceholder("") && isPlaceholder(undefined) && !isPlaceholder("https://x.org"));
  const away = { hostname: "localhost", pathname: "/" };
  assert.deepEqual(resolveLinks({ REPO_URL: placeholder, VIDEO_URL: "", PAPER_URL: "" }, away), { REPO_URL: "", VIDEO_URL: "", PAPER_URL: "" });
  assert.deepEqual(resolveLinks({ REPO_URL: placeholder }, { hostname: "adan.github.io", pathname: "/invisible-solar-pk/" }).REPO_URL,
    "https://github.com/adan/invisible-solar-pk");
  assert.equal(resolveLinks({ REPO_URL: placeholder }, { hostname: "adan.github.io", pathname: "/index.html" }).REPO_URL, "");
  const set = resolveLinks({ REPO_URL: "https://github.com/a/b", VIDEO_URL: "javascript:alert(1)", PAPER_URL: "http://x.org/p.pdf" }, away);
  assert.deepEqual(set, { REPO_URL: "https://github.com/a/b", VIDEO_URL: "", PAPER_URL: "" });
  // the shipped config.js only ever yields https links or hidden ones
  const win = {};
  new Function("window", readFileSync(docs("assets/config.js"), "utf8"))(win);
  assert.deepEqual(Object.keys(win.INVISIBLE_SOLAR_CONFIG), ["REPO_URL", "VIDEO_URL", "PAPER_URL"]);
  for (const v of Object.values(resolveLinks(win.INVISIBLE_SOLAR_CONFIG, away))) assert.ok(v === "" || v.startsWith("https://"), v);
});

test("referenceRecord picks the newest Accepted attestation, else the newest, like latestAccepted()", async () => {
  const mock = (statuses) => ({
    count: async () => BigInt(statuses.length),
    get: async (_sid, i) => ({ status: BigInt(STATUS_NAMES.indexOf(statuses[i])), evidenceHash: `0x${String(i).repeat(64)}` }),
  });
  assert.deepEqual(await referenceRecord(mock(["Accepted", "Disputed"]), "0xsid"),
    { stationId: "0xsid", index: 0, status: "Accepted", hash: "0".repeat(64) });
  assert.equal((await referenceRecord(mock(["Accepted", "Accepted"]), "s")).index, 1);
  assert.deepEqual(await referenceRecord(mock(["Pending", "Disputed"]), "s"), { stationId: "s", index: 1, status: "Disputed", hash: "1".repeat(64) });
  assert.equal(await referenceRecord(mock([]), "s"), null);
});

test("the page's registry ABI matches the compiled BTMRegistry", async (t) => {
  const ethers = await loadEthers();
  const artifactPath = repo("chain/artifacts/chain/contracts/BTMRegistry.sol/BTMRegistry.json");
  if (!ethers || !existsSync(artifactPath)) return t.skip("ethers or the compiled artifact is not available (run npx hardhat compile)");
  const page = new ethers.Interface(REGISTRY_ABI);
  const compiled = new ethers.Interface(JSON.parse(readFileSync(artifactPath, "utf8")).abi);
  page.forEachFunction((fn) => {
    const real = compiled.getFunction(fn.name);
    assert.ok(real, `${fn.name} exists in BTMRegistry`);
    assert.equal(fn.selector, real.selector, `${fn.name} selector`);
    assert.deepEqual(fn.outputs.map((o) => o.format("sighash")), real.outputs.map((o) => o.format("sighash")), `${fn.name} outputs`);
    assert.deepEqual(fn.outputs.flatMap((o) => (o.components || []).map((c) => c.name)),
      real.outputs.flatMap((o) => (o.components || []).map((c) => c.name)), `${fn.name} field names`);
  });
  const statusEnum = /enum Status \{([^}]*)\}/.exec(readFileSync(repo("chain/contracts/BTMRegistry.sol"), "utf8"));
  assert.deepEqual(statusEnum[1].split(",").map((s) => s.trim()), STATUS_NAMES);
});

test("deployment.json station ids are keccak256 of the station name, as the page computes them", async (t) => {
  const ethers = await loadEthers();
  if (!ethers || !deployment?.attestations?.length) return t.skip("ethers or docs/data/deployment.json not available");
  for (const a of deployment.attestations) assert.equal(a.stationId, ethers.id(a.station), a.station);
});

test("index.html sets a Content-Security-Policy and needs no inline script or style", () => {
  const html = readFileSync(docs("index.html"), "utf8");
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(csp, "CSP meta tag present");
  assert.ok(html.indexOf(csp[0]) < html.indexOf("<link"), "CSP comes before any resource");
  const policy = Object.fromEntries(csp[1].split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  for (const directive of ["script-src", "style-src"]) {
    assert.ok(!policy[directive].some((v) => /unsafe/.test(v)), `${directive} has no unsafe-* source`);
  }
  assert.deepEqual(policy["object-src"], ["'none'"]);
  assert.ok(policy["connect-src"].includes("https://ethereum-sepolia-rpc.publicnode.com"));
  const app = readFileSync(docs("assets/app.js"), "utf8");
  assert.ok(app.includes('"https://ethereum-sepolia-rpc.publicnode.com"'), "app.js RPC is the CSP's connect-src");
  assert.ok(policy["script-src"].includes(new URL(/url: "([^"]+)"/.exec(app)[1]).origin), "ethers CDN allowed by script-src");
  assert.doesNotMatch(html, /\sstyle\s*=/i, "no style attributes");
  assert.doesNotMatch(html, /<style/i, "no <style> blocks");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline event handlers");
  for (const tag of html.match(/<script\b[^>]*>/gi)) assert.match(tag, /\ssrc=/, `inline script: ${tag}`);
  for (const f of ["app.js", "chart.js", "dom.js"]) {
    assert.doesNotMatch(readFileSync(docs(`assets/${f}`), "utf8"), /[{,]\s*style\s*:/, `${f} passes no style attribute to h()/svg()`);
  }
});

test("every `npm run` command named on the page or in the architecture figure exists in package.json", (t) => {
  const pkgPath = repo("package.json");
  if (!existsSync(pkgPath)) return t.skip("package.json not present (docs copied on its own)");
  const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts;
  const named = new Set();
  for (const f of ["index.html", "architecture.svg", "assets/app.js"]) {
    for (const m of readFileSync(docs(f), "utf8").matchAll(/npm run ([\w:.-]+)/g)) named.add(m[1]);
  }
  const svg = readFileSync(docs("architecture.svg"), "utf8");
  for (const m of svg.matchAll(/\b(verify|deploy|anchor):([a-z]+)\b/g)) named.add(m[0]);
  assert.ok(named.size >= 2, `found ${[...named]}`);
  for (const s of named) assert.ok(scripts[s], `npm script "${s}" is missing from package.json`);
});

test("architecture.png has the size of architecture.svg (re-render it at that size after editing the SVG)", () => {
  const png = readFileSync(docs("architecture.png"));
  assert.equal(png.toString("latin1", 1, 4), "PNG");
  const [w, hgt] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  const svg = readFileSync(docs("architecture.svg"), "utf8");
  const [, sw, sh] = /<svg[^>]*width="(\d+)" height="(\d+)"/.exec(svg);
  assert.deepEqual([w, hgt], [Number(sw), Number(sh)]);
});

test("the registry disclosure states the accept band that chain/scripts/lib.js applies", (t) => {
  const libPath = repo("chain/scripts/lib.js");
  if (!existsSync(libPath)) return t.skip("chain/scripts/lib.js not present");
  const lib = readFileSync(libPath, "utf8");
  const band = ["ACCEPT_MIN_BP", "ACCEPT_MAX_BP"].map((k) => Number(new RegExp(`const ${k} = (\\d+);`).exec(lib)[1]) / 100);
  const html = readFileSync(docs("index.html"), "utf8");
  const disclosure = /<p class="disclosure">([\s\S]*?)<\/p>/.exec(html)[1];
  assert.match(disclosure, new RegExp(`between ${band[0]}% and ${band[1]}%`));
  assert.match(disclosure, /No regulator has reviewed/);
});

test("validation.json agrees with site.json and the manifest to the table's rounding", () => {
  for (const r of site.regions) {
    const v = validation.regions[r.station];
    const m = manifest.attestations.find((a) => a.station === r.station);
    assert.ok(Math.abs(v.corr_full - r.corr_hourly) <= 0.0005 + 1e-9, `${r.station} corr_full`);
    assert.ok(Math.abs(v.corr_daylight_full - r.corr_daylight) <= 0.0005 + 1e-9, `${r.station} corr_daylight`);
    assert.ok(Math.abs(v.recovery_full_pct - r.energy_recovery_pct) <= 0.05 + 1e-9, `${r.station} recovery`);
    assert.ok(Math.abs(v.recovery_full_pct - m.energy_recovery_bp / 100) <= 0.05 + 1e-9, `${r.station} manifest bp`);
    assert.equal(v.naive_recovery_full_pct, r.naive_recovery_pct, `${r.station} naive`);
  }
});

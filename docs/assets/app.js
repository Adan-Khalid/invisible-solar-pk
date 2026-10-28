// Demo page: fills the headline, region cards, registry table and "Verify it yourself" from
// docs/data/*.json and docs/assets/validation.json (never hard-coded numbers). Static, relative
// URLs only, so it works from a sub-path such as <user>.github.io/<repo>/.
import { h, $, $$, num, icon } from "./dom.js";
import { createChart, dailyTable, dayLabel, parseStamp } from "./chart.js";
import {
  sha256Hex, tamperOneReading, demoTamperLine, lineOfTimestamp, hashesEqual, normalizeHash, shortHash, countLines,
} from "./verify.js";
import { LINK_KEYS, isPlaceholder, explorerUrl, resolveLinks } from "./links.js";
import { REGISTRY_ABI, referenceRecord } from "./registry.js";

const CONFIG = window.INVISIBLE_SOLAR_CONFIG || {};
// The RPC origin is also the only connect-src besides 'self' in index.html's Content-Security-Policy.
const SEPOLIA = { chainId: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com" };
const ETHERS = {
  url: "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js",
  sri: "sha512-V3xRGsQMQ8CG4l2gVN44TCDmNY5cdlxbSvejrgmWxcLKHft0Q3XQDbeuJ9aot14mpNuRWGtI//WKraedDGNZ+g==",
};
const HARDHAT_ACCOUNT_0 = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // regulator in a local demo run
const TAMPER_DELTA_MW = 1;
// The reading chain/scripts/demo.js edits (TAMPER_TS), so tampering NSW in the browser reproduces
// the evidence hash of the Disputed record in the recorded local run.
const TAMPER_STAMP = "2024-01-01T13:00";
const UNDER_RECOVERY_PCT = 90; // regions below this are called out under "Honest limits"
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- data

async function loadJson(url, { optional = false } = {}) {
  let res;
  try {
    res = await fetch(url, { cache: "no-cache" });
  } catch (err) {
    if (optional) return null;
    throw new Error(`${url}: ${err.message}`);
  }
  if (!res.ok) {
    if (optional && res.status === 404) return null;
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return res.json();
}

function validDeployment(dep) {
  if (!dep) return null;
  const ok = typeof dep.network === "string" && /^0x[0-9a-fA-F]{40}$/.test(dep.address || "") && Array.isArray(dep.attestations);
  if (!ok) console.warn("docs/data/deployment.json ignored: missing network, address or attestations");
  return ok ? dep : null;
}

const VALIDATION_KEYS = ["recovery_full_pct", "corr_full", "corr_daylight_full", "recovery_oddeven_pct", "naive_recovery_full_pct"];

/** station -> results-table row (assets/validation.json); stations with a malformed row are skipped. */
function validationMap(validation) {
  const out = new Map();
  for (const [station, row] of Object.entries(validation?.regions || {})) {
    if (VALIDATION_KEYS.every((k) => Number.isFinite(row?.[k]))) out.set(station, row);
  }
  return out;
}

const networkMode = (dep) => (!dep ? "none" : dep.network === "sepolia" ? "sepolia" : "local");

const stationOrder = (manifest) => (station) => {
  const i = manifest.attestations.findIndex((m) => m.station === station);
  return i < 0 ? Infinity : i;
};

/**
 * One entry per manifest station for "Verify it yourself". The reference hash is what a planner
 * would get from latestAccepted(): the newest Accepted record, else the newest record, else the manifest.
 * On Sepolia the check reads that record from the contract itself (resolveReference); these values
 * from deployment.json are then only compared with it.
 */
function verifyStations(manifest, deployment, site) {
  return manifest.attestations.map((m) => {
    const records = (deployment?.attestations || []).filter((a) => a.station === m.station).sort((a, b) => a.index - b.index);
    const onchain = records.filter((a) => a.status === "Accepted").at(-1) || records.at(-1) || null;
    const region = site.regions.find((r) => r.station === m.station) || {};
    return {
      station: m.station,
      name: region.name || m.station,
      file: m.evidence_file,
      onchain,
      manifestHash: normalizeHash(m.evidence_sha256),
      anchoredHash: normalizeHash(onchain ? onchain.evidenceSha256 : m.evidence_sha256),
      ui: {},
    };
  });
}

function manifestRecord(m, name) {
  return {
    station: m.station, name, index: null, hash: normalizeHash(m.evidence_sha256),
    capacityKw: m.capacity_kw_eff, uncertaintyKw: m.uncertainty_kw, recoveryBp: m.energy_recovery_bp,
    status: null, note: null, att: null, differs: false,
  };
}

/**
 * Registry table: every attest() call in the deployment record, plus one manifest row
 * ("Not anchored yet") for each station that has no attestation, e.g. right after deploy:sepolia.
 */
function registryRecords(manifest, deployment, site) {
  const nameOf = (station) => site.regions.find((r) => r.station === station)?.name || station;
  const atts = deployment?.attestations || [];
  const anchored = new Set(atts.map((a) => a.station));
  const fromChain = atts.map((a) => {
    const m = manifest.attestations.find((x) => x.station === a.station);
    return {
      station: a.station, name: nameOf(a.station), index: a.index, hash: normalizeHash(a.evidenceSha256),
      capacityKw: a.capacityKwEff, uncertaintyKw: a.uncertaintyKw, recoveryBp: a.energyRecoveryBp,
      status: a.status, note: a.statusNote || null, att: a,
      differs: !m || !hashesEqual(a.evidenceSha256, m.evidence_sha256),
    };
  });
  const notYet = manifest.attestations.filter((m) => !anchored.has(m.station)).map((m) => manifestRecord(m, nameOf(m.station)));
  const order = stationOrder(manifest);
  return [...fromChain, ...notYet].sort((a, b) => order(a.station) - order(b.station) || (a.index ?? -1) - (b.index ?? -1));
}

// ---------------------------------------------------------------- shared bits

const spanRange = (values, fmt) => {
  const lo = fmt(Math.min(...values));
  const hi = fmt(Math.max(...values));
  return lo === hi ? lo : `${lo}–${hi}`;
};

const shortCode = (station) => station.split("/").pop().replace(/\d+$/, "");

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h("textarea", { class: "sr-only", readonly: true, "aria-hidden": "true" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function announce(msg) {
  const el = $("#announcer");
  el.textContent = "";
  requestAnimationFrame(() => { el.textContent = msg; });
}

function copyButton(text, label, display) {
  return h("button", {
    type: "button", class: "copy", title: `${text}\n(click to copy)`, "aria-label": `Copy ${label}`,
    onclick: async (e) => {
      const ok = await copyText(text);
      const btn = e.currentTarget;
      btn.dataset.state = ok ? "copied" : "failed";
      announce(ok ? `Copied ${label}` : `Could not copy ${label}; select it manually`);
      setTimeout(() => { delete btn.dataset.state; }, 1600);
    },
  }, display ?? null, icon("copy"));
}

function statusPill(status, note) {
  const map = {
    Accepted: ["ok", "check", "Accepted"],
    Disputed: ["bad", "cross", "Disputed"],
    Pending: ["wait", "clock", "Pending"],
  };
  const [tone, ic, label] = map[status] || ["none", "dash", "Not anchored yet"];
  return h("span", { class: `pill pill--${tone}`, title: note ? `Note from the demo regulator account: ${note}` : null }, icon(ic), label);
}

function txCell(att, dep) {
  if (!att?.tx) return h("span", { class: "muted" }, "—");
  const short = shortHash(att.tx, 6, 4);
  const href = explorerUrl(dep?.explorer, "tx", att.tx);
  if (href) return h("a", { class: "mono", href, target: "_blank", rel: "noopener", title: att.tx }, `0x${short}`);
  return h("span", { class: "mono", title: `${att.tx} (block ${att.block ?? "?"})` }, `0x${short}`);
}

// ---------------------------------------------------------------- hero + results

function renderHeadline(site, val) {
  const r = site.regions;
  $("[data-stat=recovery]").textContent = `${spanRange(r.map((x) => x.energy_recovery_pct), (v) => num(v))}%`;
  $("[data-stat=regions]").textContent = `${r.length}`;
  $("[data-stat=corr]").textContent = spanRange(r.map((x) => x.corr_hourly), (v) => v.toFixed(2));
  $("[data-stat=corr-day]").textContent = spanRange(r.map((x) => x.corr_daylight), (v) => v.toFixed(2));
  $("[data-stat=naive]").textContent = `${spanRange(r.map((x) => x.naive_recovery_pct), (v) => num(v))}%`;
  const held = r.map((x) => val.get(x.station)?.recovery_oddeven_pct);
  const slot = $("[data-stat=heldout]");
  if (held.every(Number.isFinite)) slot.textContent = `${spanRange(held, (v) => num(v))}%`;
  else slot.closest("[data-heldout-wrap]")?.setAttribute("hidden", "");
}

function recoveryMeter(region, v) {
  const rows = [
    ["Ours · full year, in-sample", region.energy_recovery_pct, "est"],
    v ? ["Ours · held-out months", v.recovery_oddeven_pct, "held"] : null,
    ["Naive midday dip", region.naive_recovery_pct, "naive"],
  ].filter(Boolean);
  const top = Math.max(...rows.map((x) => x[1]));
  const max = Math.max(120, Math.ceil(top / 10) * 10 + 10);
  const pos = (value) => `${(100 * value) / max}%`;
  const label = rows.map(([name, value]) => `${name} ${num(value, 1)}%`).join("; ");
  // Geometry goes through the CSSOM (element.style), which the page's CSP allows; style="" attributes it blocks.
  const fill = (tone, value) => {
    const el = h("span", { class: `meter__fill meter__fill--${tone}` });
    el.style.width = pos(value);
    return el;
  };
  const meter = h("div", {
    class: "meter", role: "img",
    "aria-label": `Energy recovered as a share of AEMO rooftop PV: ${label}.`,
  },
  rows.flatMap(([name, value, tone]) => [
    h("span", { class: "meter__label" }, name),
    h("span", { class: "meter__value" }, `${num(value, 1)}%`),
    h("span", { class: "meter__track" }, fill(tone, value)),
  ]),
  h("span", { class: "meter__scale" }, h("span", {}, "AEMO = 100%")));
  meter.style.setProperty("--truth", pos(100));
  return meter;
}

function corrFigs(region, v) {
  // Three decimals straight from the results table; the 4-dp site.json values are shown at 2 dp
  // only as a fallback, so nothing is rounded twice.
  const all = v ? v.corr_full.toFixed(3) : region.corr_hourly.toFixed(2);
  const day = v ? v.corr_daylight_full.toFixed(3) : region.corr_daylight.toFixed(2);
  const fig = (label, value) => h("div", { class: "fig" }, h("dt", {}, label), h("dd", {}, h("span", { class: "fig__value" }, value)));
  return h("dl", { class: "figs figs--pair" }, fig("All hours", all), fig("Daylight only", day));
}

function regionCard(region, v) {
  const chart = createChart(region);
  const daily = dailyTable(region);
  // The summary's click runs before the <details> opens, so the chart's height is still the tall one.
  daily.querySelector("summary").addEventListener("click", () => chart.holdHeight(!daily.open));
  const code = region.station.split("/").pop();
  const card = h("article", { class: "region", "aria-labelledby": `rt-${code}` },
    h("div", { class: "region__side" },
      h("header", { class: "region__head" },
        h("p", { class: "region__code mono" }, region.station, h("span", {}, ` · ${region.city}`)),
        h("h3", { id: `rt-${code}` }, region.name)),
      h("dl", { class: "figs" },
        h("div", { class: "fig fig--wide" },
          h("dt", {}, "Effective capacity"),
          h("dd", {}, h("span", { class: "fig__value" }, num(region.capacity_mw_eff)), h("span", { class: "fig__unit" }, " MW"),
            h("span", { class: "fig__sub" }, `± ${num(region.uncertainty_mw)} MW seasonal spread`)))),
      h("p", { class: "side__title" }, "Hourly correlation with AEMO, 2024"),
      corrFigs(region, v),
      h("p", { class: "side__title" }, "Energy recovered vs AEMO, 2024"),
      recoveryMeter(region, v),
      v ? h("p", { class: "meter__note" }, "Held-out: fitted on odd months, scored on even months.") : null),
    h("div", { class: "region__main" }, chart.root, daily));
  return { card, chart };
}

function renderRegions(site, val) {
  const built = site.regions.map((r) => regionCard(r, val.get(r.station)));
  $("#regions").replaceChildren(...built.map((b) => b.card));
  const toggle = $("#toggle-net");
  toggle.addEventListener("click", () => {
    const on = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(on));
    built.forEach((b) => b.chart.setShowNet(on));
  });
}

// ---------------------------------------------------------------- registry

function registrySummary(records) {
  const count = (s) => records.filter((r) => r.status === s).length;
  const parts = [`${records.length} attestation${records.length === 1 ? "" : "s"}`];
  for (const s of ["Accepted", "Pending", "Disputed"]) if (count(s)) parts.push(`${count(s)} ${s.toLowerCase()}`);
  return parts;
}

function badge(tone, title, tally, ...body) {
  return h("div", { class: `netbadge netbadge--${tone}` },
    h("span", { class: `led led--${tone}`, "aria-hidden": "true" }),
    h("div", {},
      h("p", { class: "netbadge__title" }, title,
        tally?.length ? h("span", { class: "netbadge__tally mono" }, tally.map((t, i) => [i ? " · " : "", h("span", {}, t)])) : null),
      h("p", {}, ...body)));
}

/** Who set the statuses: never a regulator so far, and the page says so wherever a status is shown. */
function regulatorNote(dep) {
  const who = /^0x[0-9a-fA-F]{40}$/.test(dep.regulator || "") ? dep.regulator : "";
  const account = who ? h("span", { class: "mono", title: who }, `${who.slice(0, 6)}…${who.slice(-4)}`) : "the regulator account";
  if (networkMode(dep) === "local") {
    const which = who.toLowerCase() === HARDHAT_ACCOUNT_0 ? ", Hardhat's default test account 0" : "";
    return [" Every status in it was set by the demo script, using the regulator account ", account, `${which}; no regulator reviewed these estimates.`];
  }
  return [" Statuses are set by chain/scripts/anchor.js from the regulator account ", account,
    ", which the project's author holds for this demo; no regulator has reviewed these estimates."];
}

function networkBanner(dep, rows) {
  const mode = networkMode(dep);
  const onchain = rows.filter((r) => r.att);
  const stations = new Set(rows.map((r) => r.station)).size;
  const missing = new Set(rows.filter((r) => !r.att).map((r) => r.station)).size;
  const tally = onchain.length ? registrySummary(onchain) : null;
  const gap = !onchain.length ? " This record holds no attestations; the hashes below come from the evidence manifest."
    : missing === 1 ? ` 1 of ${stations} stations has no attestation yet; its row shows the evidence-manifest hash.`
      : missing ? ` ${missing} of ${stations} stations have no attestation yet; their rows show the evidence-manifest hash.` : "";
  if (mode === "sepolia") {
    const href = explorerUrl(dep.explorer, "address", dep.address);
    const where = ["BTMRegistry at ",
      href ? h("a", { class: "mono", href, target: "_blank", rel: "noopener" }, dep.address) : h("span", { class: "mono" }, dep.address),
      ` · chain ${dep.chainId}.`];
    if (!onchain.length) {
      return badge("pending", "Deployed on Sepolia", null, ...where,
        " No estimate is anchored yet: the hashes below come from the evidence manifest. The Verify buttons read the contract first and compare against these hashes while it holds nothing.");
    }
    const links = href ? " Every anchored row links to its transaction, and the" : " The";
    return badge("live", "Live on Sepolia", tally, ...where,
      `${links} Verify buttons read each record from the contract itself.${gap}`,
      ...regulatorNote(dep));
  }
  if (mode === "local") {
    const day = /^\d{4}-\d{2}-\d{2}/.exec(String(dep.generatedAt || ""));
    const when = day ? ` on ${day[0]}` : "";
    return badge("local", "Recorded local run", tally,
      `Hardhat in-process network, ephemeral: the contract existed only for the length of the run${when}. Run `,
      h("code", {}, "npm run demo"), ` to reproduce it. Nothing is on a public network yet.${gap}`,
      ...(onchain.length ? regulatorNote(dep) : []));
  }
  return badge("none", "Not yet deployed", null,
    "The hashes below come from the evidence manifest: they are what the estimator wallet anchors with ",
    h("code", {}, "attest()"), ". Run ", h("code", {}, "npm run demo"), " for a local run.");
}

function registryRow(rec, dep) {
  const disputed = rec.status === "Disputed";
  const ref = `${rec.station}${rec.index !== null ? ` #${rec.index}` : ""}`;
  return h("tr", { class: disputed ? "is-disputed" : null },
    h("th", { scope: "row" },
      h("span", { class: "mono" }, rec.station, rec.index !== null ? h("span", { class: "idx" }, ` #${rec.index}`) : null),
      h("span", { class: "cell-sub" }, rec.name)),
    h("td", { "data-label": "Capacity", class: "num" }, `${num(rec.capacityKw / 1000)} MW`),
    h("td", { "data-label": "± seasonal", class: "num" }, `${num(rec.uncertaintyKw / 1000)} MW`),
    h("td", { "data-label": "In-sample recovery", class: "num" }, `${num(rec.recoveryBp / 100, 1)}%`),
    h("td", { "data-label": "Status", class: "cell-status" }, statusPill(rec.status, rec.note),
      disputed && rec.note ? h("span", { class: "cell-note" }, rec.note) : null),
    h("td", { "data-label": "Evidence SHA-256", class: "cell-hash" },
      copyButton(rec.hash, `evidence hash for ${ref}`, h("span", { class: "mono" }, shortHash(rec.hash))),
      rec.differs ? h("span", { class: "cell-warn" }, "≠ published file") : null),
    h("td", { "data-label": "Tx" }, txCell(rec.att, dep)));
}

function renderRegistry(rows, manifest, dep) {
  $("#netbadge").replaceChildren(networkBanner(dep, rows));
  $("#registry-body").replaceChildren(...rows.map((r) => registryRow(r, dep)));
  const facts = [
    ["Estimator", manifest.estimator],
    ["Code hash", h("span", {}, copyButton(manifest.code_hash, "code hash", h("span", { class: "mono" }, shortHash(manifest.code_hash, 10, 8))),
      " SHA-256 of the four estimator source files")],
    ["Hash rule", manifest.hash_rule],
  ];
  if (dep) {
    facts.unshift(["Contract", h("span", { class: "mono" }, dep.address)]);
    if (dep.note) facts.push(["Note", dep.note]);
  }
  $("#registry-facts").replaceChildren(...facts.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))));
}

// ---------------------------------------------------------------- verify

const evidenceCache = new Map();
async function fetchEvidence(file) {
  if (!evidenceCache.has(file)) {
    evidenceCache.set(file, (async () => {
      const res = await fetch(`evidence/${encodeURIComponent(file)}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`evidence/${file}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, text: new TextDecoder("utf-8").decode(bytes) };
    })().catch((err) => { evidenceCache.delete(file); throw err; }));
  }
  return evidenceCache.get(file);
}

let ethersPromise = null;
function loadEthers() {
  if (window.ethers) return Promise.resolve(window.ethers);
  ethersPromise ??= new Promise((resolve, reject) => {
    const tag = h("script", { src: ETHERS.url, integrity: ETHERS.sri, crossorigin: "anonymous", referrerpolicy: "no-referrer" });
    tag.onload = () => (window.ethers ? resolve(window.ethers) : reject(new Error("ethers did not initialise")));
    tag.onerror = () => { ethersPromise = null; reject(new Error("could not load ethers.js from cdnjs")); };
    document.head.append(tag);
  });
  return ethersPromise;
}

let registryPromise = null;
/** Read-only BTMRegistry on Sepolia through the public RPC, plus ethers' keccak256(utf8) for station ids. */
function sepoliaRegistry(dep) {
  registryPromise ??= loadEthers()
    .then(({ JsonRpcProvider, Contract, id }) => ({
      contract: new Contract(dep.address, REGISTRY_ABI, new JsonRpcProvider(SEPOLIA.rpc, SEPOLIA.chainId, { staticNetwork: true })),
      stationIdOf: id,
    }))
    .catch((err) => { registryPromise = null; throw err; });
  return registryPromise;
}

const chainRefs = new Map();
/** The station's reference record read from the contract (stationId computed here), cached per page view. */
function chainReference(dep, station) {
  if (!chainRefs.has(station)) {
    chainRefs.set(station, sepoliaRegistry(dep)
      .then(({ contract, stationIdOf }) => referenceRecord(contract, stationIdOf(station)))
      .catch((err) => { chainRefs.delete(station); throw err; }));
  }
  return chainRefs.get(station);
}

async function chainVerify(dep, rec, hex) {
  const { contract } = await sepoliaRegistry(dep);
  return contract.verify(rec.stationId, rec.index, `0x${normalizeHash(hex)}`);
}

function chainError(err, dep) {
  // BAD_DATA: the call returned nothing decodable, i.e. no BTMRegistry code at that address.
  return err?.code === "BAD_DATA" ? `no BTMRegistry answered at ${dep.address}` : err?.shortMessage || err?.message || String(err);
}

/** A hash row; a hash that differs from `against` is shown whole in the "bad" colour (SHA-256 has no partial match). */
function hashLine(label, hex, against) {
  const differs = against !== undefined && !hashesEqual(hex, against);
  return h("div", { class: "hashline" }, h("dt", {}, label),
    h("dd", { class: `mono hash${differs ? " hash--differs" : ""}` }, hex, differs ? h("span", { class: "sr-only" }, " (different)") : null));
}

function verdict(match, detail) {
  return h("p", { class: `verdict verdict--${match ? "ok" : "bad"}` },
    icon(match ? "check" : "cross"), h("strong", {}, match ? "MATCH" : "MISMATCH"), h("span", {}, detail));
}

/** Label of a reference hash taken from the page's own data files (deployment.json or the manifest). */
function recordLabel(dep, row) {
  const mode = networkMode(dep);
  if (mode === "none" || !row.onchain) return "Manifest hash (not anchored yet)";
  if (mode === "sepolia") return `Sepolia #${row.onchain.index} · ${row.onchain.status}, as listed in deployment.json`;
  return `Anchored in local run #${row.onchain.index} · ${row.onchain.status}`;
}

/** A sentence when deployment.json disagrees with the record read from the contract, else null. */
function staleRecordWarning(row, rec) {
  const listed = row.onchain;
  if (listed && listed.index === rec.index && listed.status === rec.status && hashesEqual(listed.evidenceSha256, rec.hash)) return null;
  const says = listed ? `lists #${listed.index} · ${listed.status} · ${shortHash(listed.evidenceSha256)}` : "has no record";
  return `docs/data/deployment.json is out of date for ${row.station}: it ${says}. The check above uses the contract's record.`;
}

/**
 * The hash a check compares against, and where it came from. Local run or no deployment: the page's data
 * files. Sepolia: the record read from the contract itself (stationId = keccak256 of the station name, newest
 * Accepted attestation), so a stale or wrong deployment.json cannot produce a MATCH; if the chain cannot be
 * read, the deployment.json record is used and the check says so.
 */
async function resolveReference(row, dep) {
  const fromFiles = { hash: row.anchoredHash, label: recordLabel(dep, row), anchored: Boolean(row.onchain), chain: null, warn: null };
  if (networkMode(dep) !== "sepolia") return fromFiles;
  try {
    const rec = await chainReference(dep, row.station);
    if (!rec) {
      return {
        hash: row.manifestHash, label: "Manifest hash (nothing anchored on Sepolia for this station)", anchored: false, chain: null,
        warn: row.onchain ? `docs/data/deployment.json lists ${row.station} #${row.onchain.index}, but the contract holds no attestation for it.` : null,
      };
    }
    return { hash: rec.hash, label: `Read from Sepolia #${rec.index} · ${rec.status}`, anchored: true, chain: rec, warn: staleRecordWarning(row, rec) };
  } catch (err) {
    return {
      ...fromFiles, recordOnly: fromFiles.anchored,
      warn: `Could not read the contract on Sepolia (${chainError(err, dep)}), so this compares against the page's own record instead.`,
    };
  }
}

/**
 * What the reference hash belongs to, for verdict sentences. Never says "anchored" without a record, and
 * says whose claim it is when the chain could not confirm the record.
 */
function refText(ref) {
  if (ref.recordOnly) return "the file deployment.json lists as anchored";
  return ref.anchored ? "the file that was anchored" : "the file listed in the evidence manifest";
}

const warnLine = (text) => (text ? h("p", { class: "chainline", "data-tone": "warn" }, icon("alert"), h("span", {}, text)) : null);

async function appendChainCheck(container, dep, row, ref, hex, expectTrue) {
  if (!ref.chain) return;
  const line = h("p", { class: "chainline" }, `Calling verify(keccak256("${row.station}"), ${ref.chain.index}, hash) on Sepolia…`);
  container.append(line);
  try {
    const ok = await chainVerify(dep, ref.chain, hex);
    line.replaceChildren(icon(ok ? "check" : "cross"), h("span", {}, "On-chain "),
      h("code", {}, `verify(…) → ${ok}`), h("span", {}, ok === expectTrue ? " as expected" : " unexpected"));
    line.dataset.tone = ok ? "ok" : "bad";
  } catch (err) {
    line.textContent = `On-chain check unavailable: ${chainError(err, dep)}`;
    line.dataset.tone = "warn";
  }
}

function busy(slot, text) {
  slot.replaceChildren(h("p", { class: "busy" }, h("span", { class: "busy__dot", "aria-hidden": "true" }), text));
}

/** The reference for a check, with a progress line while it is read from Sepolia. */
async function referenceFor(slot, row, dep) {
  if (networkMode(dep) === "sepolia") busy(slot, `Reading ${row.station}'s anchored record from the contract on Sepolia…`);
  return resolveReference(row, dep);
}

async function verifyStation(row, dep) {
  const slot = row.ui.verify;
  busy(slot, `Fetching evidence/${row.file} and hashing it…`);
  try {
    const ev = await fetchEvidence(row.file);
    const hex = await sha256Hex(ev.bytes);
    const ref = await referenceFor(slot, row, dep);
    const match = hashesEqual(hex, ref.hash);
    const box = h("div", { class: `vres vres--${match ? "ok" : "bad"}` },
      h("p", { class: "vres__meta" }, `evidence/${row.file} · ${num(ev.bytes.length)} bytes · ${num(countLines(ev.text) - 1)} hourly rows`),
      h("dl", {}, hashLine("Computed in your browser", hex, ref.hash), hashLine(ref.label, ref.hash)),
      verdict(match, match ? `byte-for-byte ${refText(ref)}` : `this file is not ${refText(ref)}`),
      warnLine(ref.warn));
    slot.replaceChildren(box);
    await appendChainCheck(box, dep, row, ref, hex, true);
    return match;
  } catch (err) {
    slot.replaceChildren(h("p", { class: "vres-error" }, `Could not verify: ${err.message}`));
    return false;
  }
}

function diffLine(sign, cells, col) {
  return h("code", { class: `diff diff--${sign === "-" ? "del" : "add"}` },
    h("span", { class: "diff__sign", "aria-hidden": "true" }, sign),
    cells.flatMap((c, i) => [i ? "," : "", i === col ? h("mark", {}, c) : c]));
}

/** A registry record whose evidence hash is exactly `hex` (the chain demo anchors one tampered file). */
function twinNote(dep, hex) {
  const twin = (dep?.attestations || []).find((a) => hashesEqual(a.evidenceSha256, hex));
  if (!twin) return null;
  const note = twin.statusNote ? ` (the demo regulator account's note: “${twin.statusNote}”)` : "";
  return h("p", { class: "vres__twin" }, icon("link"),
    h("span", {}, `Registry record ${twin.station} #${twin.index} holds exactly this hash. Its status: `,
      h("strong", {}, twin.status), `${note}.`));
}

async function tamperStation(row, dep) {
  const slot = row.ui.tamper;
  busy(slot, "Changing one reading and re-hashing…");
  try {
    const ev = await fetchEvidence(row.file);
    const t = tamperOneReading(ev.text, lineOfTimestamp(ev.text, TAMPER_STAMP) ?? demoTamperLine(ev.text), TAMPER_DELTA_MW);
    const col = ev.text.slice(0, ev.text.indexOf("\n")).split(",").indexOf(t.column);
    const hex = await sha256Hex(t.text);
    const ref = await referenceFor(slot, row, dep);
    const match = hashesEqual(hex, ref.hash);
    const box = h("div", { class: `vres vres--${match ? "ok" : "bad"} vres--tamper` },
      h("p", { class: "vres__meta" }, `Line ${num(t.lineNo)} · ${t.timestamp} · ${t.column}: ${t.oldValue} → ${t.newValue} (+${TAMPER_DELTA_MW} MW, in memory only)`),
      h("div", { class: "diffbox", role: "group", "aria-label": "Changed line, before and after" },
        diffLine("-", t.before.split(","), col), diffLine("+", t.after.split(","), col)),
      h("dl", {}, hashLine("Hash of the edited file", hex, ref.hash), hashLine(ref.label, ref.hash)),
      verdict(match, match ? "unexpected: the edit did not change the hash" : `one reading out of ${num(countLines(ev.text) - 1)} changed, and the fingerprint is unrecognisable`),
      warnLine(ref.warn),
      twinNote(dep, hex));
    slot.replaceChildren(box);
    await appendChainCheck(box, dep, row, ref, hex, false);
    return !match;
  } catch (err) {
    slot.replaceChildren(h("p", { class: "vres-error" }, `Could not run the tamper demo: ${err.message}`));
    return false;
  }
}

function verifyRow(row, dep) {
  row.ui.verify = h("div", { class: "vrow__slot", "aria-live": "polite" });
  row.ui.tamper = h("div", { class: "vrow__slot", "aria-live": "polite" });
  // Accessible names keep the visible text first (WCAG 2.5.3) and add the station, so the four
  // rows' buttons can be told apart in a screen reader's list of controls.
  const tamperText = `Tamper one reading (+${TAMPER_DELTA_MW} MW)`;
  return h("li", { class: "vrow" },
    h("div", { class: "vrow__head" },
      h("p", { class: "vrow__id" }, h("span", { class: "mono" }, row.station), h("span", {}, row.name)),
      h("div", { class: "vrow__actions" },
        h("button", { type: "button", class: "cbtn cbtn--go", "aria-label": `Verify ${row.station} (${row.name})`, onclick: () => verifyStation(row, dep) },
          icon("check"), "Verify"),
        h("button", { type: "button", class: "cbtn cbtn--warn", "aria-label": `${tamperText}: ${row.station} (${row.name})`, onclick: () => tamperStation(row, dep) },
          tamperText),
        h("a", { class: "cbtn cbtn--link", href: `evidence/${row.file}`, download: row.file, "aria-label": `Download file ${row.file}` }, "Download file"))),
    row.ui.verify, row.ui.tamper);
}

function renderCli(row) {
  const f = row.file;
  const cmds = [
    ["Linux / Git Bash", `sha256sum ${f}`],
    ["macOS", `shasum -a 256 ${f}`],
    ["Windows cmd", `certutil -hashfile ${f} SHA256`],
    ["PowerShell", `Get-FileHash -Algorithm SHA256 ${f}`],
  ];
  $("#cli-file").replaceChildren(h("a", { href: `evidence/${f}`, download: f }, f));
  $("#cli-cmds").replaceChildren(...cmds.map(([os, cmd]) => h("li", {},
    h("span", { class: "cmds__os" }, os), h("code", { class: "cmds__cmd" }, cmd), copyButton(cmd, `command for ${os}`))));
  // Two 32-character halves wrap evenly on narrow columns; selecting still copies one unbroken hash.
  $("#cli-expected").replaceChildren(
    h("code", { class: "mono hash hash--groups" }, row.anchoredHash.match(/.{1,32}/g).map((g) => h("span", {}, g))),
    copyButton(row.anchoredHash, `expected hash for ${row.station}`));
}

async function hashLocalFile(file, row, dep) {
  const out = $("#drop-out");
  busy(out, `Hashing ${file.name} locally…`);
  try {
    const hex = await sha256Hex(await file.arrayBuffer());
    const ref = await referenceFor(out, row, dep);
    const what = ref.recordOnly ? "the evidence deployment.json lists as anchored" : ref.anchored ? "the anchored evidence" : "the manifest's evidence file";
    const match = hashesEqual(hex, ref.hash);
    out.replaceChildren(h("div", { class: `vres vres--${match ? "ok" : "bad"}` },
      h("p", { class: "vres__meta" }, `${file.name} · ${num(file.size)} bytes · compared with ${row.station}`),
      h("dl", {}, hashLine("Your file", hex, ref.hash), hashLine(ref.label, ref.hash)),
      verdict(match, match ? `identical to ${what} for ${row.station}` : `not ${what} for ${row.station}`),
      warnLine(ref.warn)));
  } catch (err) {
    out.replaceChildren(h("p", { class: "vres-error" }, `Could not read that file: ${err.message}`));
  }
}

function setupDrop(rows, dep) {
  const select = $("#drop-station");
  select.replaceChildren(...rows.map((r, i) => h("option", { value: i }, `${r.station} · ${r.name}`)));
  const current = () => rows[Number(select.value) || 0];
  select.addEventListener("change", () => renderCli(current()));
  renderCli(current());

  const zone = $("#drop-zone");
  const input = $("#drop-file");
  input.addEventListener("change", () => { if (input.files[0]) hashLocalFile(input.files[0], current(), dep); });
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.dataset.over = "true"; }));
  ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, () => { delete zone.dataset.over; }));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) hashLocalFile(file, current(), dep);
  });
  // A file dropped next to the zone must not navigate away from the page.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

function renderVerify(rows, dep) {
  $("#verify-rows").replaceChildren(...rows.map((r) => verifyRow(r, dep)));
  $("#verify-all").addEventListener("click", async () => {
    for (const r of rows) await verifyStation(r, dep);
  });
  setupDrop(rows, dep);
}

// ---------------------------------------------------------------- limits + links + nav

function renderLimits(site, dep, val) {
  const under = site.regions.filter((r) => r.energy_recovery_pct < UNDER_RECOVERY_PCT);
  if (under.length) {
    const gap = under.reduce((a, r) => a + (100 - r.energy_recovery_pct), 0) / under.length;
    $("[data-limit=under]").textContent =
      `${under.map((r) => r.name).join(" and ")} under-recover by about ${num(gap)}%`;
  }
  const held = site.regions.map((r) => [shortCode(r.station), val.get(r.station)?.recovery_oddeven_pct]);
  if (held.every(([, v]) => Number.isFinite(v))) {
    const list = held.map(([c, v]) => `${num(v, 1)}% (${c})`);
    $("[data-limit=heldout]").textContent =
      `On a held-out split (fitted on odd months, scored on even months) it recovers ${list.slice(0, -1).join(", ")} and ${list.at(-1)}.`;
  }
  const s = site.regions[0].series;
  const t0 = parseStamp(s.start);
  $("[data-limit=window]").textContent =
    `${dayLabel(t0)} to ${dayLabel(t0 + (s.pv_measured_mw.length - 1) * s.step_hours * 3600e3)}`;
  const anchored = (dep?.attestations || []).length > 0;
  $("[data-limit=chain]").textContent = {
    sepolia: anchored ? "The registry is on the Sepolia test network, not on mainnet."
      : "The registry is deployed on the Sepolia test network (not mainnet), but no estimate is anchored on it yet.",
    local: "The registry has only run on a local Hardhat network so far; nothing is on a public chain yet.",
    none: "The registry has not been deployed to a public network yet; the tests and demo run on a local Hardhat network.",
  }[networkMode(dep)];
}

/** Header and footer links from config.js (links.js): https:// only; anything else hides that link. */
function renderLinks() {
  const links = resolveLinks(CONFIG, location);
  for (const key of LINK_KEYS) {
    if (!isPlaceholder(CONFIG[key]) && !links[key]) console.warn(`config.js ${key} ignored: only https:// URLs are linked`);
  }
  for (const el of $$("[data-link]")) {
    const url = links[el.dataset.link];
    if (url) el.setAttribute("href", url);
    else el.closest("[data-link-wrap]")?.setAttribute("hidden", "");
  }
}

/** Marks the nav link of the section in the middle of the viewport with aria-current. */
function trackSections() {
  const links = new Map($$(".nav a[href^='#']").map((a) => [a.getAttribute("href").slice(1), a]));
  if (!("IntersectionObserver" in window) || !links.size) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.removeAttribute("aria-current"));
      links.get(e.target.id)?.setAttribute("aria-current", "true");
    }
  }, { rootMargin: "-40% 0px -55% 0px" });
  $$("main > section[id]").forEach((s) => io.observe(s));
}

function showFatal(err) {
  console.error(err);
  const box = $("#fatal");
  box.hidden = false;
  box.replaceChildren(h("strong", {}, "Could not load the data files. "),
    `${err.message}. If you opened index.html straight from disk, serve the docs folder over http instead (for example: python -m http.server --directory docs).`);
}

async function main() {
  renderLinks();
  trackSections();
  const [site, manifest, rawDep, validation] = await Promise.all([
    loadJson("data/site.json"), loadJson("data/manifest.json"),
    loadJson("data/deployment.json", { optional: true }), loadJson("assets/validation.json", { optional: true }),
  ]);
  const dep = validDeployment(rawDep);
  const val = validationMap(validation);
  document.documentElement.dataset.network = networkMode(dep);
  renderHeadline(site, val);
  renderRegions(site, val);
  renderRegistry(registryRecords(manifest, dep, site), manifest, dep);
  const stations = verifyStations(manifest, dep, site);
  renderVerify(stations, dep);
  renderLimits(site, dep, val);
  if (params.get("autoverify") === "1") {
    for (const s of stations) await verifyStation(s, dep);
    await tamperStation(stations[0], dep);
  }
}

main().catch(showFatal);

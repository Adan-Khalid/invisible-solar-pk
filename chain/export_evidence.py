"""Build the evidence bundles that BTMRegistry anchors, plus the data the web verifier shows.

    python chain/export_evidence.py            # rebuild in a temporary folder and compare; writes nothing
    python chain/export_evidence.py --write    # also replace the published files where they differ

Needs the raw AEMO + NASA POWER downloads (see data/README.md). For each of the four NEM regions
with an AEMO rooftop-PV series (ROOFTOP_PV_ACTUAL, type MEASUREMENT: AEMO's measurement-based
estimate, used as the independent reference) it
  1. writes the canonical evidence CSV (AEMO_<region>_2024.csv),
  2. re-reads that file and fits the hourly IRR estimator on it, so the anchored numbers
     are reproducible from the published bundle alone (chain/verify_estimate.py),
  3. records the file's SHA-256, the estimate and its validation in manifest.json,
  4. builds a compact chart/summary file (site.json) for the GitHub Pages site.

Everything is built in a temporary folder first and compared byte for byte with the published
set: chain/evidence/{AEMO_*_2024.csv, manifest.json}, docs/evidence/AEMO_*_2024.csv and
docs/data/{manifest,site}.json. The evidence hashes are anchored on chain and quoted in the
deployment records (docs/data/deployment.json, chain/deployments/*.json), so a rebuild must never
replace them silently (an upstream data revision or another library version would otherwise give a
new, self-consistent set that no longer matches the chain).

Exit status: 0 if the rebuild is identical (nothing is touched) or --write replaced the files that
differ; 1 if anything differs and --write was not given (the differences are listed, nothing is
written); 2 if an input is missing (raw downloads, or a region absent from
results/tables/m1_multiregion_nem.csv) or a value cannot be written as strict JSON.
The on-chain part (deploy, attest, verify, tamper test) is in chain/scripts/*.js (Hardhat).
"""
import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import pandas as pd  # noqa: E402

from invisible_solar import __version__  # noqa: E402
from invisible_solar import evidence as E  # noqa: E402
from invisible_solar import hidden_pv as H  # noqa: E402
from invisible_solar.data import load_aemo_region  # noqa: E402

REGIONS = {  # region: (display name, weather city)
    "NSW1": ("New South Wales", "Sydney"), "QLD1": ("Queensland", "Brisbane"),
    "VIC1": ("Victoria", "Melbourne"), "SA1": ("South Australia", "Adelaide"),
}
CHART_WINDOW = ("2024-10-07", "2024-10-20")  # two spring weeks with sunny and cloudy days
EVID_DIR = ROOT / "chain" / "evidence"
SITE_DIR = ROOT / "docs"
NEM_TABLE = ROOT / "results" / "tables" / "m1_multiregion_nem.csv"
# files and folders of deployment records that quote anchored evidence hashes
DEPLOYMENT_RECORDS = (ROOT / "docs" / "data" / "deployment.json", ROOT / "chain" / "deployments")
# per-attestation values that are on chain (or define what the anchored file covers)
ANCHORED_KEYS = ("evidence_sha256", "capacity_kw_eff", "uncertainty_kw", "energy_recovery_bp",
                 "period_start", "period_end", "n_hours")
VALIDATION_KEYS = ("energy_recovery_pct", "corr_hourly", "corr_daylight")


class InputError(Exception):
    """A required input is missing or unusable (exit status 2)."""


def _round(values, nd=1):
    return [round(float(v), nd) for v in values]


def _rel(path: Path) -> str:
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _dump(obj, path: Path, **kw) -> None:
    """Strict JSON (allow_nan=False): a bare NaN token makes browsers reject the whole file, and the
    site would show only 'Could not load the data files'."""
    try:
        text = json.dumps(obj, allow_nan=False, **kw)
    except ValueError as exc:
        raise InputError(f"{Path(path).name}: {exc} (a NaN or infinite value)") from exc
    Path(path).write_text(text + "\n", encoding="utf-8", newline="\n")


def naive_recovery(table: Path | None = None) -> dict:
    """{region: full-year recovery % of the naive midday-dip baseline}, shown next to each
    estimate on the site. InputError naming the regions the table lacks."""
    table = Path(NEM_TABLE if table is None else table)
    if not table.is_file():
        raise InputError(f"{_rel(table)} not found: run scripts/07_multiregion_and_scale.py first")
    multi = pd.read_csv(table)
    naive = multi[multi["method"].str.startswith("Naive")].groupby("region")["recovery_full_pct"].first()
    missing = [r for r in REGIONS if pd.isna(naive.get(r, float("nan")))]
    if missing:
        raise InputError(f"{_rel(table)} has no naive-baseline recovery for {', '.join(missing)}: "
                         "rerun scripts/07_multiregion_and_scale.py")
    return {r: float(naive[r]) for r in REGIONS}


def _attestation(region: str, path: Path, est, digest: str) -> dict:
    return dict(
        station=f"AEMO/{region}", evidence_file=path.name, evidence_sha256=digest,
        period_start=est.period_start, period_end=est.period_end, n_hours=est.n_hours,
        capacity_kw_eff=est.capacity_kw_eff, uncertainty_kw=est.uncertainty_kw,
        energy_recovery_bp=int(round(est.energy_recovery_pct * 100)),
        validation=dict(energy_recovery_pct=est.energy_recovery_pct, corr_hourly=est.corr_hourly,
                        corr_daylight=est.corr_daylight,
                        kind="in-sample: fitted on net load + irradiance of the same year; the PV truth is never used in fitting",
                        truth="AEMO MMSDM ROOFTOP_PV_ACTUAL, type MEASUREMENT (AEMO's measurement-based estimate)"),
        uncertainty_rule="standard deviation of the 12 monthly capacity estimates (seasonal spread), not a confidence interval",
    )


def _site_region(region: str, path: Path, est, digest: str, df: pd.DataFrame, naive_pct: float) -> dict:
    name, city = REGIONS[region]
    pv_hat = H.fit_irr(df, country="AU").pv_hat
    win = df.loc[CHART_WINDOW[0]:CHART_WINDOW[1]]
    return dict(
        station=f"AEMO/{region}", name=name, city=city, evidence_file=path.name, evidence_sha256=digest,
        capacity_mw_eff=round(est.capacity_kw_eff / 1000), uncertainty_mw=round(est.uncertainty_kw / 1000),
        energy_recovery_pct=est.energy_recovery_pct, corr_hourly=est.corr_hourly, corr_daylight=est.corr_daylight,
        naive_recovery_pct=naive_pct,
        mean_net_load_mw=round(float(df["net_load_mw"].mean())), peak_pv_mw=round(float(df["pv_mw"].max())),
        # pv_measured_mw is the key docs/assets/chart.js reads; it holds AEMO's measurement-based
        # rooftop-PV estimate (labelled "AEMO rooftop PV" on the site), not a metered census
        series=dict(start=f"{win.index[0]:%Y-%m-%dT%H:%M}", step_hours=1,
                    net_load_mw=_round(win["net_load_mw"]), pv_measured_mw=_round(win["pv_mw"]),
                    pv_estimated_mw=_round(pv_hat.loc[win.index])),
    )


def build(out_dir: Path, naive: dict) -> dict:
    """Write evidence/<bundle>.csv, manifest.json and site.json into out_dir from the raw downloads;
    return the manifest."""
    out_dir = Path(out_dir)
    code = E.code_hash(ROOT / "src" / "invisible_solar")
    attestations, site_regions = [], []
    for region in REGIONS:
        path = E.write_evidence_csv(load_aemo_region(region), out_dir / "evidence" / f"AEMO_{region}_2024.csv")
        df = E.read_evidence_csv(path)  # the estimate comes from the bundle, never from the raw frame
        est = E.estimate_from_evidence(df, country="AU")
        digest = E.sha256_file(path)
        attestations.append(_attestation(region, path, est, digest))
        site_regions.append(_site_region(region, path, est, digest, df, naive[region]))
        print(f"{region}: {est.capacity_kw_eff / 1000:,.0f} MW effective, recovery {est.energy_recovery_pct:.1f}%, "
              f"corr {est.corr_hourly:.3f}, sha256 {digest[:16]}...")

    manifest = dict(schema=E.SCHEMA, code_version=__version__, code_hash=code,
                    estimator="IRR hourly (invisible_solar.hidden_pv.fit_irr, Fourier order 2, country=AU)",
                    hash_rule="SHA-256 of the evidence file bytes exactly as published (UTF-8, LF line endings)",
                    attestations=attestations)
    _dump(manifest, out_dir / "manifest.json", indent=2)
    site = dict(schema=E.SCHEMA, code_version=__version__, code_hash=code, regions=site_regions)
    _dump(site, out_dir / "site.json", separators=(",", ":"))
    return manifest


def published_pairs(evidence_files) -> list:
    """(path inside the build folder, published path) for every published copy."""
    pairs = []
    for name in evidence_files:
        pairs += [(f"evidence/{name}", EVID_DIR / name), (f"evidence/{name}", SITE_DIR / "evidence" / name)]
    return pairs + [("manifest.json", EVID_DIR / "manifest.json"),
                    ("manifest.json", SITE_DIR / "data" / "manifest.json"),
                    ("site.json", SITE_DIR / "data" / "site.json")]


def differing(build_dir: Path, pairs) -> list:
    """The pairs whose published file is missing or not byte-identical to the rebuilt one."""
    return [(src, dst) for src, dst in pairs
            if not Path(dst).is_file() or Path(dst).read_bytes() != (Path(build_dir) / src).read_bytes()]


def anchored_changes(old: dict | None, new: dict) -> list:
    """One line per anchored or validation value that differs between the published manifest
    (None if there is none) and the rebuilt one."""
    if old is None:
        return ["no published manifest.json: every attestation would be new"]
    lines = []
    if old.get("code_hash") != new["code_hash"]:
        lines.append(f"code_hash: {old.get('code_hash')} -> {new['code_hash']}")
    before = {a["station"]: a for a in old.get("attestations", [])}
    for a in new["attestations"]:
        b = before.pop(a["station"], None)
        if b is None:
            lines.append(f"{a['station']}: new attestation")
            continue
        lines += [f"{a['station']} {k}: {b.get(k)} -> {a[k]}" for k in ANCHORED_KEYS if b.get(k) != a[k]]
        bv, av = b.get("validation", {}), a["validation"]
        lines += [f"{a['station']} validation.{k}: {bv.get(k)} -> {av[k]}" for k in VALIDATION_KEYS
                  if bv.get(k) != av[k]]
    return lines + [f"{station}: published but no longer built" for station in before]


def records_quoting(hashes) -> list:
    """Deployment records (DEPLOYMENT_RECORDS) whose text contains any of these evidence hashes."""
    hashes = [h for h in hashes if h]
    files = []
    for p in map(Path, DEPLOYMENT_RECORDS):
        files += sorted(p.glob("*.json")) if p.is_dir() else ([p] if p.is_file() else [])
    return [f for f in files if any(h in f.read_text(encoding="utf-8") for h in hashes)]


def _report(diff, old: dict | None, new: dict) -> None:
    print("\nthe rebuild differs from the published files:")
    for _, dst in diff:
        print(f"  {'missing' if not Path(dst).is_file() else 'differs':<8} {_rel(dst)}")
    lines = anchored_changes(old, new)
    if lines:
        print("anchored values (on chain and in the deployment records) that would change:")
        print("\n".join("  " + line for line in lines))
    else:
        print("anchored values and evidence hashes unchanged: only the site data or a published copy differs")


def _install(build_dir: Path, diff) -> None:
    for src, dst in diff:
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(build_dir) / src, dst)
        print(f"  wrote {_rel(dst)}")


def _warn_stale_records(old: dict | None, new: dict) -> None:
    replaced = ({a["evidence_sha256"] for a in (old or {}).get("attestations", [])}
                - {a["evidence_sha256"] for a in new["attestations"]})
    stale = records_quoting(replaced)
    if stale:
        print("\nWARNING: these deployment records still quote the replaced evidence hashes, so every "
              "verifier will report a mismatch until the bundles are re-anchored (chain/scripts, docs/DEPLOY.md):")
        print("\n".join(f"  {_rel(p)}" for p in stale))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--write", action="store_true",
                    help="replace the published files that differ from the rebuild (changed evidence "
                         "hashes then need re-anchoring)")
    args = ap.parse_args(argv)

    old_path = EVID_DIR / "manifest.json"
    old = json.loads(old_path.read_text(encoding="utf-8")) if old_path.is_file() else None
    try:
        naive = naive_recovery()
        with tempfile.TemporaryDirectory(prefix="evidence-build-") as tmp:
            new = build(Path(tmp), naive)
            pairs = published_pairs(a["evidence_file"] for a in new["attestations"])
            diff = differing(Path(tmp), pairs)
            if not diff:
                print(f"\nthe rebuild is byte-identical to all {len(pairs)} published files; nothing written")
                return 0
            _report(diff, old, new)
            if not args.write:
                print("\nnothing written. If the change is intended, rerun with --write and re-anchor "
                      "every changed evidence hash before publishing.")
                return 1
            print(f"\n--write: replacing {len(diff)} published file(s)")
            _install(Path(tmp), diff)
    except (InputError, FileNotFoundError) as exc:
        print(f"export_evidence: {exc}", file=sys.stderr)
        return 2
    _warn_stale_records(old, new)
    return 0


if __name__ == "__main__":
    sys.exit(main())

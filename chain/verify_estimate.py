"""Re-derive anchored estimates from the published evidence files alone.

    python chain/verify_estimate.py                      # every bundle listed in manifest.json
    python chain/verify_estimate.py path/to/AEMO_SA1_2024.csv [...]

For each file (matched to its manifest entry by file name) it checks that
  1. the SHA-256 of the file bytes equals the manifest's evidence_sha256 (the on-chain evidenceHash),
  2. re-fitting the hourly IRR estimator on the file reproduces capacity_kw_eff, uncertainty_kw and
     energy_recovery_bp exactly (the integers stored on chain), and the same period_start,
     period_end (also on chain) and n_hours,
and that the estimator source here hashes to the manifest's code_hash (the on-chain codeHash).
Exit status: 0 if every check passes; 1 if any check fails (a code_hash mismatch counts, unless
--allow-code-change turns it into a warning); 2 if a file is unknown or missing, the holiday
calendar the estimator ran with cannot be determined, or the `holidays` package it needs cannot be
imported. Needs only the Python requirements, no raw downloads and no blockchain node (the on-chain
side is chain/scripts/verify-evidence.js).

The anchored codeHash covers the estimator source, not the libraries it runs on, so the header
prints the numpy, pandas, statsmodels and holidays versions in use next to the ones pinned in
requirements-lock.txt (the versions the anchored numbers were produced with).
"""
import argparse
import json
import os
import platform
import re
import sys
from importlib import metadata
from pathlib import Path

# One fit is a ~8800 x 300 least-squares problem: multi-threaded BLAS only adds contention (several
# times slower on a busy 8-core machine). Set before numpy loads; export the variables to override.
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from invisible_solar import evidence as E  # noqa: E402
from invisible_solar import features as F  # noqa: E402

ANCHORED = ("capacity_kw_eff", "uncertainty_kw", "energy_recovery_bp")  # the estimate's integers
PERIOD = ("period_start", "period_end", "n_hours")                     # what the file covers
FIELDS = ANCHORED + PERIOD
LOCK = ROOT / "requirements-lock.txt"
# libraries whose versions can move the re-fitted integers (hidden_pv.fit_irr: statsmodels OLS on a
# pandas design with numpy maths and a holidays calendar)
VERSIONED = ("numpy", "pandas", "statsmodels", "holidays")
INSTALL_HINT = "pip install -r requirements-lock.txt"


def holidays_importable() -> bool:
    """features.py falls back to no holiday feature when `holidays` cannot be imported, which
    silently changes every re-fit; check the estimator's own import, not just the package."""
    return getattr(F, "_hol", None) is not None


def locked_versions(path: Path = LOCK) -> dict:
    """{package name (lower case): version} for every 'name==version' pin in the lock file."""
    pins = {}
    if Path(path).is_file():
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            m = re.match(r"\s*([A-Za-z0-9_.-]+)==([^\s;#]+)", line)
            if m:
                pins[m.group(1).lower()] = m.group(2)
    return pins


def versions_line(pins: dict | None = None) -> tuple[str, bool]:
    """'Python 3.11.0, numpy 2.4.6, ...' with '(lock X)' after any version that differs from the
    lock file; and whether all of VERSIONED match it."""
    pins = locked_versions() if pins is None else pins
    parts, all_match = [f"Python {platform.python_version()}"], True
    for name in VERSIONED:
        try:
            have = metadata.version(name)
        except metadata.PackageNotFoundError:
            have = "not installed"
        want = pins.get(name)
        if want and have != want:
            all_match = False
            parts.append(f"{name} {have} (lock {want})")
        else:
            parts.append(f"{name} {have}")
    return ", ".join(parts), all_match


def manifest_country(manifest: dict) -> str | None:
    """Holiday calendar the estimator ran with: the manifest's explicit 'country' field if it has
    one, else the 'country=XX' token in its free-text 'estimator' description."""
    if manifest.get("country"):
        return manifest["country"]
    m = re.search(r"country=([A-Z]{2})", manifest.get("estimator", ""))
    return m.group(1) if m else None


def check_file(path: Path, entry: dict, country: str) -> dict:
    row = dict(station=entry["station"], file=str(path), errors=[])
    digest = E.sha256_file(path)
    row["hash_ok"] = digest == entry["evidence_sha256"]
    if not row["hash_ok"]:
        row["errors"].append(f"sha256 {digest[:16]}... != manifest {entry['evidence_sha256'][:16]}...")
    try:
        est = E.estimate_from_evidence(E.read_evidence_csv(path), country=country)
    except Exception as exc:  # a truncated or edited file may not even parse
        row["errors"].append(f"re-fit failed: {type(exc).__name__}: {exc}")
        row["refit"] = {}
        row["refit_ok"] = False
        return row
    refit = dict(capacity_kw_eff=est.capacity_kw_eff, uncertainty_kw=est.uncertainty_kw,
                 energy_recovery_bp=None if est.energy_recovery_pct is None else int(round(est.energy_recovery_pct * 100)),
                 period_start=est.period_start, period_end=est.period_end, n_hours=est.n_hours)
    row["refit"] = refit
    row["refit_ok"] = all(refit[k] == entry.get(k) for k in FIELDS)
    for k in FIELDS:
        if refit[k] != entry.get(k):
            row["errors"].append(f"{k}: re-fit {refit[k]} != anchored {entry.get(k)}")
    return row


def _print_table(rows: list, by_name: dict):
    head = (f"{'station':<11} {'sha256':<7} {'capacity_kw_eff':>23} {'uncertainty_kw':>21} {'recovery_bp':>13} "
            f"{'period':<7} result")
    print("\n" + head + "\n" + "-" * len(head))
    for r in rows:
        e, f = by_name[Path(r["file"]).name], r["refit"]
        cells = [f"{e[k]:>{w}}" if f.get(k) == e[k] else f"{e[k]}->{f.get(k, '?')}".rjust(w)
                 for k, w in zip(ANCHORED, (23, 21, 13))]
        period_ok = all(f.get(k) == e.get(k) for k in PERIOD)
        ok = r["hash_ok"] and r["refit_ok"]
        print(f"{r['station']:<11} {'ok' if r['hash_ok'] else 'BAD':<7} {cells[0]} {cells[1]} {cells[2]} "
              f"{'ok' if period_ok else 'BAD':<7} {'REPRODUCED' if ok else 'FAILED'}")
        for err in r["errors"]:
            print(f"{'':<11} - {err}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("files", nargs="*", type=Path, help="evidence CSVs (default: all manifest entries)")
    ap.add_argument("--manifest", type=Path, default=ROOT / "chain" / "evidence" / "manifest.json",
                    help="manifest to check against (default: chain/evidence/manifest.json)")
    ap.add_argument("--allow-code-change", action="store_true",
                    help="only warn (do not fail) when the estimator source no longer hashes to code_hash")
    args = ap.parse_args(argv)

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    by_name = {a["evidence_file"]: a for a in manifest["attestations"]}
    files = args.files or [args.manifest.parent / name for name in by_name]
    unknown = [f for f in files if f.name not in by_name]
    if unknown:
        print("not in manifest: " + ", ".join(str(f) for f in unknown), file=sys.stderr)
        return 2
    missing = [f for f in files if not f.is_file()]
    if missing:
        print("file not found: " + ", ".join(str(f) for f in missing), file=sys.stderr)
        return 2
    country = manifest_country(manifest)
    if country is None:
        print("cannot tell which holiday calendar the estimator ran with: the manifest has no 'country' "
              "field and no 'country=XX' in its 'estimator' text", file=sys.stderr)
        return 2
    if not holidays_importable():
        print(f"the estimator ran with the {country} holiday calendar, but the 'holidays' package cannot be "
              f"imported here, so every re-fit would differ from the anchored numbers: {INSTALL_HINT}",
              file=sys.stderr)
        return 2

    code = E.code_hash(ROOT / "src" / "invisible_solar")
    code_ok = code == manifest["code_hash"]
    versions, versions_match = versions_line()
    print(f"manifest   {args.manifest}")
    print(f"code_hash  {code}  {'== manifest' if code_ok else 'MISMATCH: manifest has ' + manifest['code_hash']}")
    if not code_ok:
        print("           (the estimator source changed since anchoring; a mismatch below may come from the code, "
              "not the data)")
    print(f"country    {country} (holiday calendar of the estimator)")
    print(f"versions   {versions}")

    rows = [check_file(f, by_name[f.name], country) for f in files]
    _print_table(rows, by_name)
    n_ok = sum(r["hash_ok"] and r["refit_ok"] for r in rows)
    code_note = "" if code_ok else (" (WARNING: code_hash differs from manifest)" if args.allow_code_change
                                    else "; FAILED: code_hash differs from manifest")
    print(f"\n{n_ok}/{len(rows)} bundles reproduce their anchored numbers{code_note}")
    if any(r["hash_ok"] and not r["refit_ok"] for r in rows):
        _print_refit_hint(versions_match)
    return 0 if n_ok == len(rows) and (code_ok or args.allow_code_change) else 1


def _print_refit_hint(versions_match: bool) -> None:
    """An intact file (hash ok) that re-fits to other numbers: point at the likeliest cause."""
    if versions_match:
        print("hint: the file is the anchored one and the library versions match requirements-lock.txt, so look "
              "at the estimator source (code_hash above), the manifest entry, or the platform's maths libraries")
    else:
        print("hint: the file is the anchored one, but the library versions differ from requirements-lock.txt "
              f"(marked 'lock' above); the re-fitted integers depend on them. Run {INSTALL_HINT} "
              "(Python 3.11) and re-check")


if __name__ == "__main__":
    sys.exit(main())

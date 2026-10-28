"""The four committed AEMO evidence bundles reproduce the anchored numbers exactly.

These are the files whose SHA-256 BTMRegistry stores on chain. Re-fitting the open-source
estimator on each file alone must give the same integers that were attested
(capacity_kw_eff, uncertainty_kw, energy_recovery_bp); no raw download is needed.
"""
import json
from pathlib import Path

import pytest

from invisible_solar import evidence as E
from invisible_solar.config import DATA_DIR
from invisible_solar.data import AEMO_REGIONS, load_aemo_region

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "chain" / "evidence"
MANIFEST = json.loads((EVIDENCE / "manifest.json").read_text(encoding="utf-8"))
ENTRIES = MANIFEST["attestations"]
IDS = [a["station"] for a in ENTRIES]


def test_manifest_shape():
    assert MANIFEST["schema"] == E.SCHEMA
    assert [a["station"] for a in ENTRIES] == ["AEMO/NSW1", "AEMO/QLD1", "AEMO/VIC1", "AEMO/SA1"]
    assert (ROOT / "docs" / "data" / "manifest.json").read_bytes() == (EVIDENCE / "manifest.json").read_bytes()


def test_code_hash_of_src_matches_manifest():
    assert E.code_hash(ROOT / "src" / "invisible_solar") == MANIFEST["code_hash"]


@pytest.mark.parametrize("entry", ENTRIES, ids=IDS)
def test_bundle_hashes_match_manifest(entry):
    for folder in (EVIDENCE, ROOT / "docs" / "evidence"):
        path = folder / entry["evidence_file"]
        assert E.sha256_file(path) == entry["evidence_sha256"], path
        raw = path.read_bytes()
        assert b"\r" not in raw and raw.split(b"\n", 1)[0].decode() == E.HEADER


@pytest.mark.evidence
@pytest.mark.parametrize("entry", ENTRIES, ids=IDS)
def test_refit_reproduces_anchored_numbers(entry):
    df = E.read_evidence_csv(EVIDENCE / entry["evidence_file"])
    est = E.estimate_from_evidence(df, country="AU")
    got = dict(capacity_kw_eff=est.capacity_kw_eff, uncertainty_kw=est.uncertainty_kw,
               energy_recovery_bp=int(round(est.energy_recovery_pct * 100)),
               period_start=est.period_start, period_end=est.period_end, n_hours=est.n_hours)
    assert got == {k: entry[k] for k in got}
    v = entry["validation"]
    assert (est.energy_recovery_pct, est.corr_hourly, est.corr_daylight) == (
        v["energy_recovery_pct"], v["corr_hourly"], v["corr_daylight"])


def missing_raw_inputs(region: str, data_dir: Path = DATA_DIR) -> list[str]:
    """Every raw file load_aemo_region(region) reads (paths relative to data_dir) that is absent:
    the derived rooftop-PV hourly file, all twelve 2024 PRICE_AND_DEMAND months and the NASA
    POWER year of the region's city."""
    city = AEMO_REGIONS[region][0]
    needed = (["intl/aemo_rooftop_all_regions_2024_hourly.csv"]
              + [f"intl/aemo_PRICE_AND_DEMAND_2024{m:02d}_{region}.csv" for m in range(1, 13)]
              + [f"weather/nasa_power_hourly_{city}_2024.csv"])
    return [name for name in needed if not (Path(data_dir) / name).is_file()]


def test_missing_raw_inputs_lists_each_absent_file(tmp_path):
    assert len(missing_raw_inputs("SA1", tmp_path)) == 14
    (tmp_path / "intl").mkdir()
    (tmp_path / "intl" / "aemo_rooftop_all_regions_2024_hourly.csv").write_text("x")
    missing = missing_raw_inputs("SA1", tmp_path)
    assert len(missing) == 13 and "weather/nasa_power_hourly_adelaide_2024.csv" in missing


@pytest.mark.rawdata
@pytest.mark.parametrize("entry", ENTRIES, ids=IDS)
def test_raw_downloads_rebuild_identical_bundle(entry, tmp_path):
    region = entry["station"].split("/")[1]
    missing = missing_raw_inputs(region)
    if missing:
        more = f" (+{len(missing) - 1} more)" if len(missing) > 1 else ""
        pytest.skip(f"raw AEMO / NASA POWER downloads not available: no {missing[0]}{more} under {DATA_DIR}")
    path = E.write_evidence_csv(load_aemo_region(region), tmp_path / entry["evidence_file"])
    assert E.sha256_file(path) == entry["evidence_sha256"]

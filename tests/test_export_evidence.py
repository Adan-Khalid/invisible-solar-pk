"""chain/export_evidence.py compares a rebuild with the published set and writes only with --write.

A real rebuild needs the raw downloads (test_real_evidence.py's rawdata test covers that). Here
build() is replaced by a copy of the committed files, optionally edited, and every published path
points into tmp_path, so the committed, hash-anchored files are never touched. One test runs the
real build() on a synthetic year to check what it writes.
"""
import importlib.util
import json
import os
import shutil
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "chain" / "evidence"
DOCS = ROOT / "docs"
COMMITTED = json.loads((EVIDENCE / "manifest.json").read_text(encoding="utf-8"))
OLD_MTIME = 1_000_000_000  # 2001-09-09: any write moves it

_spec = importlib.util.spec_from_file_location("export_evidence", ROOT / "chain" / "export_evidence.py")
X = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(X)


@pytest.fixture
def published(tmp_path, monkeypatch) -> Path:
    """A copy of the published set (bundles, both manifests, site.json and the deployment records)
    under tmp_path/repo, with the module's paths pointed at it and every mtime set to OLD_MTIME."""
    repo = tmp_path / "repo"
    evid, site, deployments = repo / "chain" / "evidence", repo / "docs", repo / "chain" / "deployments"
    shutil.copytree(EVIDENCE, evid)
    shutil.copytree(DOCS / "evidence", site / "evidence")
    (site / "data").mkdir(parents=True)
    for name in ("manifest.json", "site.json", "deployment.json"):
        shutil.copyfile(DOCS / "data" / name, site / "data" / name)
    deployments.mkdir()
    (deployments / "unrelated.json").write_text('{"note": "quotes no evidence hash"}', encoding="utf-8")
    for p in repo.rglob("*"):
        if p.is_file():
            os.utime(p, (OLD_MTIME, OLD_MTIME))
    monkeypatch.setattr(X, "EVID_DIR", evid)
    monkeypatch.setattr(X, "SITE_DIR", site)
    monkeypatch.setattr(X, "DEPLOYMENT_RECORDS", (site / "data" / "deployment.json", deployments))
    return repo


def snapshot(repo: Path) -> dict:
    return {p.relative_to(repo).as_posix(): (p.read_bytes(), p.stat().st_mtime)
            for p in repo.rglob("*") if p.is_file()}


def fake_build(edit=None):
    """build() stand-in: copies the committed bundles, manifest.json and site.json into the build
    folder; edit(out_dir, manifest) may then change them and returns the manifest to report."""
    def build(out_dir, naive):
        (out_dir / "evidence").mkdir(parents=True)
        for a in COMMITTED["attestations"]:
            shutil.copyfile(EVIDENCE / a["evidence_file"], out_dir / "evidence" / a["evidence_file"])
        shutil.copyfile(EVIDENCE / "manifest.json", out_dir / "manifest.json")
        shutil.copyfile(DOCS / "data" / "site.json", out_dir / "site.json")
        manifest = json.loads(json.dumps(COMMITTED))
        return edit(out_dir, manifest) if edit else manifest
    return build


def revised_sa1(out_dir: Path, manifest: dict) -> dict:
    """What an upstream data revision looks like: one SA1 hour 1 MW higher, so the bundle hashes
    differently and the re-fit capacity moves; the manifest is rewritten to match."""
    path = out_dir / "evidence" / "AEMO_SA1_2024.csv"
    lines = path.read_text(encoding="utf-8").split("\n")
    row = lines[5000].split(",")
    row[1] = f"{float(row[1]) + 1:.3f}"
    lines[5000] = ",".join(row)
    path.write_bytes("\n".join(lines).encode("utf-8"))
    sa1 = next(a for a in manifest["attestations"] if a["station"] == "AEMO/SA1")
    sa1.update(evidence_sha256=X.E.sha256_file(path), capacity_kw_eff=sa1["capacity_kw_eff"] + 7)
    X._dump(manifest, out_dir / "manifest.json", indent=2)
    return manifest


SA1_OLD = next(a for a in COMMITTED["attestations"] if a["station"] == "AEMO/SA1")


@pytest.mark.parametrize("argv", [[], ["--write"]])
def test_identical_rebuild_touches_nothing(published, monkeypatch, capsys, argv):
    monkeypatch.setattr(X, "build", fake_build())
    before = snapshot(published)
    assert X.main(argv) == 0
    assert snapshot(published) == before
    assert "byte-identical to all 11 published files; nothing written" in capsys.readouterr().out


def test_changed_bundle_is_listed_and_not_written(published, monkeypatch, capsys):
    monkeypatch.setattr(X, "build", fake_build(revised_sa1))
    before = snapshot(published)
    assert X.main([]) == 1
    assert snapshot(published) == before
    out = capsys.readouterr().out
    assert "AEMO_SA1_2024.csv" in out and "AEMO_NSW1_2024.csv" not in out
    assert f"AEMO/SA1 evidence_sha256: {SA1_OLD['evidence_sha256']} -> " in out
    assert f"AEMO/SA1 capacity_kw_eff: {SA1_OLD['capacity_kw_eff']} -> {SA1_OLD['capacity_kw_eff'] + 7}" in out
    assert "nothing written" in out and "--write" in out


def test_write_replaces_only_the_changed_files_and_flags_stale_records(published, monkeypatch, capsys):
    monkeypatch.setattr(X, "build", fake_build(revised_sa1))
    before = snapshot(published)
    assert X.main(["--write"]) == 0
    after = snapshot(published)
    assert {k for k in after if after[k] != before[k]} == {
        "chain/evidence/AEMO_SA1_2024.csv", "docs/evidence/AEMO_SA1_2024.csv",
        "chain/evidence/manifest.json", "docs/data/manifest.json"}
    manifest = json.loads((published / "chain" / "evidence" / "manifest.json").read_text(encoding="utf-8"))
    sa1 = next(a for a in manifest["attestations"] if a["station"] == "AEMO/SA1")
    assert X.E.sha256_file(published / "chain" / "evidence" / "AEMO_SA1_2024.csv") == sa1["evidence_sha256"]
    out = capsys.readouterr().out
    assert "WARNING" in out and "deployment.json" in out and "unrelated.json" not in out


def test_missing_naive_region_exits_2_before_building(published, monkeypatch, tmp_path, capsys):
    table = tmp_path / "m1_multiregion_nem.csv"
    pd.read_csv(X.NEM_TABLE).query("region != 'SA1'").to_csv(table, index=False)
    monkeypatch.setattr(X, "NEM_TABLE", table)
    monkeypatch.setattr(X, "build", lambda *a: pytest.fail("build ran although an input was missing"))
    assert X.main([]) == 2
    assert "no naive-baseline recovery for SA1" in capsys.readouterr().err


def test_missing_raw_downloads_exit_2_and_touch_nothing(published, monkeypatch, capsys):
    def no_downloads(region):
        raise FileNotFoundError(f"no aemo_PRICE_AND_DEMAND_2024*_{region}.csv in /nowhere/intl")
    monkeypatch.setattr(X, "load_aemo_region", no_downloads)
    before = snapshot(published)
    assert X.main([]) == 2
    assert "aemo_PRICE_AND_DEMAND_2024*_NSW1.csv" in capsys.readouterr().err
    assert snapshot(published) == before


def test_naive_recovery_matches_the_published_site_data():
    site = json.loads((DOCS / "data" / "site.json").read_text(encoding="utf-8"))
    assert X.naive_recovery() == {r["station"].split("/")[1]: r["naive_recovery_pct"] for r in site["regions"]}


def test_nan_is_refused_rather_than_written_as_a_bare_token(tmp_path):
    with pytest.raises(X.InputError, match="site.json"):
        X._dump({"naive_recovery_pct": float("nan")}, tmp_path / "site.json")
    assert not (tmp_path / "site.json").exists()


def test_anchored_changes_lists_code_new_and_dropped_stations():
    old = json.loads(json.dumps(COMMITTED))
    new = json.loads(json.dumps(COMMITTED))
    assert X.anchored_changes(old, new) == []
    assert X.anchored_changes(None, new) == ["no published manifest.json: every attestation would be new"]
    new["code_hash"] = "f" * 64
    new["attestations"][0]["validation"]["corr_hourly"] = 0.5
    new["attestations"][1]["station"] = "AEMO/TAS1"
    lines = X.anchored_changes(old, new)
    assert lines[0] == f"code_hash: {COMMITTED['code_hash']} -> {'f' * 64}"
    assert any(line.startswith("AEMO/NSW1 validation.corr_hourly: ") for line in lines)
    assert "AEMO/TAS1: new attestation" in lines and "AEMO/QLD1: published but no longer built" in lines


def test_build_writes_bundle_derived_numbers_and_strict_json(tmp_path, monkeypatch, make_year):
    year = make_year(seed=3, capacity_mw=300.0, year=2024)
    monkeypatch.setattr(X, "REGIONS", {"SA1": ("South Australia", "Adelaide")})
    monkeypatch.setattr(X, "load_aemo_region", lambda region: year)
    manifest = X.build(tmp_path, {"SA1": 55.4})
    (a,) = manifest["attestations"]
    bundle = tmp_path / "evidence" / "AEMO_SA1_2024.csv"
    assert a["evidence_file"] == bundle.name and a["evidence_sha256"] == X.E.sha256_file(bundle)
    est = X.E.estimate_from_evidence(X.E.read_evidence_csv(bundle), country="AU")
    assert (a["capacity_kw_eff"], a["uncertainty_kw"], a["n_hours"]) == (
        est.capacity_kw_eff, est.uncertainty_kw, est.n_hours)
    assert json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8")) == manifest
    (r,) = json.loads((tmp_path / "site.json").read_text(encoding="utf-8"))["regions"]
    assert r["naive_recovery_pct"] == 55.4 and r["evidence_sha256"] == a["evidence_sha256"]
    assert r["series"]["start"] == "2024-10-07T00:00" and len(r["series"]["net_load_mw"]) == 14 * 24

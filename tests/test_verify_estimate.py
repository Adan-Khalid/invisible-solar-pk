"""chain/verify_estimate.py: exit codes, the period and code_hash checks, and the country lookup.

That the re-fit reproduces every anchored number is test_real_evidence.py's job. Here the real
SA1 estimate is computed once and reused, so only the tampered-file case pays for another fit.
"""
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "chain" / "evidence"
SA1 = EVIDENCE / "AEMO_SA1_2024.csv"
MANIFEST = json.loads((EVIDENCE / "manifest.json").read_text(encoding="utf-8"))

_spec = importlib.util.spec_from_file_location("verify_estimate", ROOT / "chain" / "verify_estimate.py")
V = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(V)


@pytest.fixture(scope="module")
def sa1_estimate():
    return V.E.estimate_from_evidence(V.E.read_evidence_csv(SA1), country="AU")


@pytest.fixture
def cached_refit(monkeypatch, sa1_estimate):
    """Re-fitting the untouched SA1 file returns the estimate computed once above; records the
    holiday calendar each call asked for."""
    countries = []

    def fake(df, country):
        countries.append(country)
        return sa1_estimate

    monkeypatch.setattr(V.E, "estimate_from_evidence", fake)
    return countries


def write_manifest(tmp_path: Path, edit) -> Path:
    """A copy of the committed manifest after edit(manifest_dict, sa1_entry)."""
    m = json.loads(json.dumps(MANIFEST))
    edit(m, next(a for a in m["attestations"] if a["station"] == "AEMO/SA1"))
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(m), encoding="utf-8")
    return path


def test_manifest_country_lookup():
    assert V.manifest_country(MANIFEST) == "AU"  # from "... country=AU)" in the estimator text
    assert V.manifest_country({"country": "PK", "estimator": "IRR hourly (country=AU)"}) == "PK"
    assert V.manifest_country({"estimator": "IRR hourly"}) is None
    assert V.manifest_country({}) is None


def test_committed_bundle_reproduces(cached_refit, capsys):
    assert V.main([str(SA1)]) == 0
    out = capsys.readouterr().out
    assert "== manifest" in out and "country    AU" in out
    assert "versions   Python " in out and all(f" {name} " in out for name in V.VERSIONED)
    assert "REPRODUCED" in out and "1/1 bundles reproduce their anchored numbers" in out
    assert "hint:" not in out
    assert cached_refit == ["AU"]


def test_explicit_country_field_wins(cached_refit, tmp_path):
    def edit(m, sa1):
        m["country"] = "AU"
        m["estimator"] = "IRR hourly"
    manifest = write_manifest(tmp_path, edit)
    assert V.main(["--manifest", str(manifest), str(SA1)]) == 0
    assert cached_refit == ["AU"]


def test_period_mismatch_fails(cached_refit, tmp_path, capsys):
    manifest = write_manifest(tmp_path, lambda m, sa1: sa1.update(period_end=20241230))
    assert V.main(["--manifest", str(manifest), str(SA1)]) == 1
    out = capsys.readouterr().out
    assert "period_end: re-fit 20241231 != anchored 20241230" in out
    assert "FAILED" in out and "0/1 bundles" in out
    assert "hint: the file is the anchored one" in out  # intact file, other numbers: say where to look


def test_refit_mismatch_hint_points_at_library_versions(cached_refit, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(V, "locked_versions", lambda path=V.LOCK: {"numpy": "0.0.1"})
    manifest = write_manifest(tmp_path, lambda m, sa1: sa1.update(capacity_kw_eff=sa1["capacity_kw_eff"] + 1))
    assert V.main(["--manifest", str(manifest), str(SA1)]) == 1
    out = capsys.readouterr().out
    assert "(lock 0.0.1)" in out and "library versions differ" in out
    assert "pip install -r requirements-lock.txt" in out


def test_missing_holidays_package_exits_2_before_any_refit(cached_refit, monkeypatch, capsys):
    monkeypatch.setattr(V.F, "_hol", None)  # what features.py falls back to when the import fails
    assert V.main([str(SA1)]) == 2
    err = capsys.readouterr().err
    assert "'holidays' package cannot be imported" in err and "requirements-lock.txt" in err
    assert cached_refit == []


def test_versions_line_compares_with_the_lock(tmp_path):
    assert set(V.VERSIONED) <= set(V.locked_versions())  # every library the re-fit depends on is pinned
    lock = tmp_path / "lock.txt"
    lock.write_text('# comment\nnumpy==0.0.1\nPuLP==3.3.2\ncolorama==0.4.6 ; sys_platform == "win32"\n',
                    encoding="utf-8")
    assert V.locked_versions(lock) == {"numpy": "0.0.1", "pulp": "3.3.2", "colorama": "0.4.6"}
    assert V.locked_versions(tmp_path / "absent.txt") == {}
    text, ok = V.versions_line({"numpy": "0.0.1"})
    assert not ok and text.startswith("Python ") and "(lock 0.0.1)" in text
    text, ok = V.versions_line({})
    assert ok and "(lock" not in text


def test_code_hash_mismatch_fails_unless_allowed(cached_refit, tmp_path, capsys):
    manifest = write_manifest(tmp_path, lambda m, sa1: m.update(code_hash="0" * 64))
    assert V.main(["--manifest", str(manifest), str(SA1)]) == 1
    assert "FAILED: code_hash differs from manifest" in capsys.readouterr().out
    assert V.main(["--manifest", str(manifest), "--allow-code-change", str(SA1)]) == 0
    out = capsys.readouterr().out
    assert "MISMATCH" in out and "WARNING: code_hash differs from manifest" in out


@pytest.mark.evidence
def test_tampered_bundle_fails_hash_and_refit(tmp_path, capsys):
    lines = SA1.read_text(encoding="utf-8").split("\n")
    row = lines[5000].split(",")  # one hour in late July: add 100 MW to its net load
    row[1] = f"{float(row[1]) + 100:.3f}"
    lines[5000] = ",".join(row)
    copy = tmp_path / SA1.name
    copy.write_bytes("\n".join(lines).encode("utf-8"))
    assert V.main([str(copy)]) == 1
    out = capsys.readouterr().out
    assert "BAD" in out and "sha256" in out and "FAILED" in out
    assert "hint:" not in out  # the file itself changed; library versions are beside the point


def test_unparseable_bundle_fails(tmp_path, capsys):
    copy = tmp_path / SA1.name
    copy.write_text("not,an,evidence,file\n", encoding="utf-8")
    assert V.main([str(copy)]) == 1
    out = capsys.readouterr().out
    assert "re-fit failed" in out and "0/1 bundles" in out


def test_unknown_or_missing_file_exits_2(tmp_path, capsys):
    stranger = tmp_path / "AEMO_XX1_2024.csv"
    stranger.write_bytes(SA1.read_bytes())
    assert V.main([str(stranger)]) == 2
    assert "not in manifest" in capsys.readouterr().err
    assert V.main([str(tmp_path / SA1.name)]) == 2  # right name, but no such file
    assert "file not found" in capsys.readouterr().err


def test_unknown_country_exits_2(tmp_path, capsys):
    manifest = write_manifest(tmp_path, lambda m, sa1: m.update(estimator="IRR hourly"))
    assert V.main(["--manifest", str(manifest), str(SA1)]) == 2
    assert "holiday calendar" in capsys.readouterr().err

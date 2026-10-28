"""Canonical evidence bundles: exact bytes, hashing rules and the estimate computed from them."""
import hashlib
import shutil

import numpy as np
import pandas as pd
import pytest

from invisible_solar import evidence as E
from invisible_solar import hidden_pv as H

COLS = ["net_load_mw", "ghi", "t2m", "pv_mw"]


@pytest.fixture(scope="module")
def quarter(synth_year):
    """Jan-Mar of the synthetic year: long enough for a well-posed fit, fast to write."""
    return synth_year.loc["2023-01-01":"2023-03-31", COLS]


def test_exact_bytes_for_a_hand_example(tmp_path):
    idx = pd.to_datetime(["2024-01-01 00:00", "2024-01-01 01:00"])
    df = pd.DataFrame({"net_load_mw": [1000.12345, 990.0], "ghi": [0.0, 120.4], "t2m": [20.5, 21.0],
                       "pv_mw": [1.25, np.nan]}, index=idx)
    path = E.write_evidence_csv(df, tmp_path / "x.csv")
    assert path.read_bytes() == (
        b"timestamp,net_load_mw,ghi_wm2,t2m_c,rooftop_pv_mw_measured\n"
        b"2024-01-01T00:00,1000.123,0.000,20.500,1.250\n"
        b"2024-01-01T01:00,990.000,120.400,21.000,\n"
    )


def test_round_trip_lf_header_and_values(quarter, tmp_path):
    path = E.write_evidence_csv(quarter, tmp_path / "sub" / "bundle.csv")  # creates parent dirs
    raw = path.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")
    assert b"\r" not in raw and raw.endswith(b"\n")
    assert raw.split(b"\n", 1)[0].decode() == E.HEADER
    back = E.read_evidence_csv(path)
    assert list(back.columns) == COLS
    assert back.index.equals(quarter.index)
    np.testing.assert_allclose(back.values, quarter.values, atol=5e-4)  # 3 fixed decimals


def test_writing_is_deterministic(quarter, tmp_path):
    a = E.write_evidence_csv(quarter, tmp_path / "a.csv").read_bytes()
    b = E.write_evidence_csv(quarter.copy(), tmp_path / "b.csv").read_bytes()
    assert a == b
    # re-writing what was read back reproduces the same bytes (the format is a fixed point)
    c = E.write_evidence_csv(E.read_evidence_csv(tmp_path / "a.csv"), tmp_path / "c.csv").read_bytes()
    assert c == a


def test_sha256_file_is_plain_sha256_of_bytes(tmp_path):
    p = tmp_path / "f.bin"
    p.write_bytes(b"invisible solar\n")
    assert E.sha256_file(p) == hashlib.sha256(b"invisible solar\n").hexdigest()


def test_nan_inputs_are_rejected(quarter, tmp_path):
    bad = quarter.copy()
    bad.iloc[5, bad.columns.get_loc("ghi")] = np.nan
    with pytest.raises(ValueError):
        E.write_evidence_csv(bad, tmp_path / "bad.csv")


def test_missing_pv_is_written_as_empty_field(quarter, tmp_path):
    path = E.write_evidence_csv(quarter.drop(columns="pv_mw"), tmp_path / "nopv.csv")
    lines = path.read_text(encoding="utf-8").splitlines()
    assert all(line.endswith(",") for line in lines[1:])
    assert E.read_evidence_csv(path)["pv_mw"].isna().all()


def _copy_sources(src_dir, dst, newline: bytes):
    dst.mkdir()
    for name in E.ESTIMATOR_FILES:
        text = (src_dir / name).read_bytes().replace(b"\r\n", b"\n")
        (dst / name).write_bytes(text.replace(b"\n", newline))
    return dst


def test_code_hash_ignores_line_endings_and_detects_one_byte(repo_root, tmp_path):
    src = repo_root / "src" / "invisible_solar"
    lf = _copy_sources(src, tmp_path / "lf", b"\n")
    crlf = _copy_sources(src, tmp_path / "crlf", b"\r\n")
    assert b"\r\n" in (crlf / "hidden_pv.py").read_bytes()
    h = E.code_hash(lf)
    assert h == E.code_hash(crlf) == E.code_hash(src)
    assert len(h) == 64

    (lf / "unrelated.py").write_text("x = 1\n")  # files outside ESTIMATOR_FILES do not count
    assert E.code_hash(lf) == h

    p = lf / "metrics.py"
    data = bytearray(p.read_bytes())
    data[-2] ^= 0x01  # flip one bit of one byte
    p.write_bytes(bytes(data))
    assert E.code_hash(lf) != h


def test_code_hash_depends_on_file_names(repo_root, tmp_path):
    src = repo_root / "src" / "invisible_solar"
    d = tmp_path / "d"
    d.mkdir()
    for name in E.ESTIMATOR_FILES:
        shutil.copyfile(src / name, d / name)
    (d / "renamed.py").write_bytes((d / "metrics.py").read_bytes())
    files = tuple(f for f in E.ESTIMATOR_FILES if f != "metrics.py") + ("renamed.py",)
    assert E.code_hash(d, files) != E.code_hash(d)


def test_estimate_from_evidence_with_and_without_pv(quarter, tmp_path):
    with_pv = E.read_evidence_csv(E.write_evidence_csv(quarter, tmp_path / "pv.csv"))
    no_pv = E.read_evidence_csv(E.write_evidence_csv(quarter.drop(columns="pv_mw"), tmp_path / "nopv.csv"))

    est = E.estimate_from_evidence(with_pv, country="AU")
    cap_kw = H.fit_irr(with_pv, country="AU").capacity_mw_by_month.dropna() * 1000
    assert est.capacity_kw_eff == int(round(cap_kw.mean()))
    assert est.uncertainty_kw == int(round(cap_kw.std()))
    assert (est.period_start, est.period_end, est.n_hours) == (20230101, 20230331, len(quarter))
    assert 80 <= est.energy_recovery_pct <= 120
    assert est.energy_recovery_pct == round(est.energy_recovery_pct, 2)
    assert est.corr_hourly > 0.9 and est.corr_daylight > 0.9

    blind = E.estimate_from_evidence(no_pv, country="AU")
    assert blind.energy_recovery_pct is None and blind.corr_hourly is None and blind.corr_daylight is None
    # the measured PV column is validation only: it never changes the anchored estimate
    assert (blind.capacity_kw_eff, blind.uncertainty_kw) == (est.capacity_kw_eff, est.uncertainty_kw)

    with pytest.raises(Exception):
        est.capacity_kw_eff = 0  # frozen

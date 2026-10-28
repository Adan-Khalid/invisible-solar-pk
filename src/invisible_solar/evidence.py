"""Canonical evidence bundles for on-chain attestations.

An evidence bundle is one CSV file holding every input the estimator used for one station
and period. Its SHA-256 (of the raw file bytes) is what BTMRegistry stores on chain, so
anyone can check it with `sha256sum`, `certutil -hashfile <file> SHA256` or a browser,
without this code. The estimate itself is computed FROM the bundle (not from the raw
downloads), so re-running the open-source estimator on the published file reproduces the
anchored capacity number exactly.

Format (schema invisible-solar-pk/evidence/v1): UTF-8, no BOM, LF line endings, one header
row, fixed decimals, hour-beginning timestamps on the station's fixed-offset local clock.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from . import hidden_pv as H

SCHEMA = "invisible-solar-pk/evidence/v1"
HEADER = "timestamp,net_load_mw,ghi_wm2,t2m_c,rooftop_pv_mw_measured"
_COLS = ["net_load_mw", "ghi", "t2m", "pv_mw"]


def write_evidence_csv(df: pd.DataFrame, path: Path) -> Path:
    """Write the canonical bundle. `df` needs net_load_mw, ghi, t2m and (optionally) pv_mw,
    the measured PV used only for validation; it is written as an empty field when absent."""
    data = df.copy()
    if "pv_mw" not in data:
        data["pv_mw"] = np.nan
    if data[["net_load_mw", "ghi", "t2m"]].isna().any().any():
        raise ValueError("evidence inputs contain NaN; drop or fill them before anchoring")
    lines = [HEADER]
    for ts, row in zip(data.index, data[_COLS].itertuples(index=False)):
        pv = "" if pd.isna(row.pv_mw) else f"{row.pv_mw:.3f}"
        lines.append(f"{ts:%Y-%m-%dT%H:%M},{row.net_load_mw:.3f},{row.ghi:.3f},{row.t2m:.3f},{pv}")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    return path


def read_evidence_csv(path: Path) -> pd.DataFrame:
    """Read a bundle back into the column names the estimators expect."""
    df = pd.read_csv(path, parse_dates=["timestamp"], index_col="timestamp")
    df.index.name = None
    return df.rename(columns={"ghi_wm2": "ghi", "t2m_c": "t2m", "rooftop_pv_mw_measured": "pv_mw"})


def sha256_file(path: Path) -> str:
    """Hex SHA-256 of the file bytes exactly as stored."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# The modules that turn an evidence file into an anchored estimate (read -> features -> fit -> summary).
ESTIMATOR_FILES = ("evidence.py", "features.py", "hidden_pv.py", "metrics.py")


def code_hash(src_dir: Path, files: tuple[str, ...] = ESTIMATOR_FILES) -> str:
    """SHA-256 over the estimator source: for each listed file in sorted order, its name, a NUL
    byte, the file text with CRLF normalised to LF, and a NUL byte. Line-ending normalisation
    keeps the hash identical on Windows and Linux checkouts. Only the modules on the
    evidence -> estimate path are covered, so unrelated analysis code can change freely."""
    h = hashlib.sha256()
    src_dir = Path(src_dir)
    for name in sorted(files):
        h.update(name.encode() + b"\0")
        h.update((src_dir / name).read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()


@dataclass(frozen=True)
class Estimate:
    capacity_kw_eff: int        # mean of the 12 monthly IRR capacities, kW at 1000 W/m2
    uncertainty_kw: int         # s.d. of the monthly capacities (seasonal spread, not a CI)
    period_start: int           # yyyymmdd
    period_end: int             # yyyymmdd
    n_hours: int
    energy_recovery_pct: float | None  # vs measured PV in the bundle, if present
    corr_hourly: float | None          # all hours (night hours are zero in both series)
    corr_daylight: float | None        # hours with measured PV > 0 only


def estimate_from_evidence(df: pd.DataFrame, country: str | None) -> Estimate:
    """Fit the hourly IRR estimator on a bundle and summarise it for attestation."""
    res = H.fit_irr(df, country=country)
    cap = res.capacity_mw_by_month.dropna() * 1000
    recovery = corr = corr_day = None
    if "pv_mw" in df and df["pv_mw"].notna().all():
        ev = H.evaluate_pv(df["pv_mw"], res.pv_hat)
        recovery, corr = round(ev["energy_recovery_pct"], 2), round(ev["corr_hourly"], 4)
        corr_day = round(ev["corr_daylight"], 4)
    return Estimate(
        capacity_kw_eff=int(round(cap.mean())),
        uncertainty_kw=int(round(cap.std())),
        period_start=int(df.index.min().strftime("%Y%m%d")),
        period_end=int(df.index.max().strftime("%Y%m%d")),
        n_hours=int(len(df)),
        energy_recovery_pct=recovery,
        corr_hourly=corr,
        corr_daylight=corr_day,
    )

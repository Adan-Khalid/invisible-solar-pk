"""Shared fixtures. Everything here is synthetic, so the suite needs no raw downloads.

The synthetic year mirrors what a distribution company sees: a baseline load with an hour x
month shape, a weekend dip and a temperature response, plus noise; irradiance from a clear-sky
model times a random daily cloudiness; and hidden PV planted as capacity * GHI/1000 * 0.8.
The estimator only ever sees net load = baseline - PV, GHI and temperature.
"""
import os
from pathlib import Path

# The matrices here are small (<= 8784 x 305): BLAS/OpenMP thread pools only add contention (one
# IRR fit costs ~1.5 CPU-s single-threaded; with 8 BLAS threads on a busy machine the four evidence
# refits took >300 CPU-s). The env vars cover libraries loaded later (LightGBM's OpenMP). pytest.ini's
# SingularMatrixWarning filter imports statsmodels, and with it numpy's OpenBLAS, before this file
# runs, so that pool is capped with threadpoolctl. Export the variables yourself to override.
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402

try:
    from threadpoolctl import threadpool_limits  # a scikit-learn dependency
    threadpool_limits(int(os.environ["OPENBLAS_NUM_THREADS"]), user_api="blas")
except ImportError:  # pragma: no cover
    pass

ROOT = Path(__file__).resolve().parents[1]  # pytest.ini puts ROOT/src on sys.path

PERFORMANCE_RATIO = 0.8  # planted PV = capacity * GHI/1000 * PERFORMANCE_RATIO


def clear_sky_ghi(index: pd.DatetimeIndex, lat_deg: float) -> np.ndarray:
    """Haurwitz clear-sky GHI (W/m2) at the middle of each hour-beginning stamp, treating the
    clock as local solar time."""
    doy = index.day_of_year.values
    hour = index.hour.values + 0.5
    decl = np.deg2rad(23.45) * np.sin(2 * np.pi * (284 + doy) / 365)
    lat = np.deg2rad(lat_deg)
    ha = np.deg2rad(15 * (hour - 12))
    cosz = np.sin(lat) * np.sin(decl) + np.cos(lat) * np.cos(decl) * np.cos(ha)
    cosz = np.clip(cosz, 0, None)
    with np.errstate(divide="ignore", over="ignore"):
        ghi = np.where(cosz > 0.01, 1098 * cosz * np.exp(-0.057 / np.maximum(cosz, 0.01)), 0.0)
    return ghi


def make_synthetic_year(seed: int = 0, capacity_mw: float = 400.0, year: int = 2023,
                        lat_deg: float = 31.5, base_mw: float = 1000.0, noise_sd: float = 0.02) -> pd.DataFrame:
    """Hourly frame with net_load_mw, ghi, t2m, pv_mw (planted truth) and baseline_mw."""
    rng = np.random.default_rng(seed)
    idx = pd.date_range(f"{year}-01-01", f"{year}-12-31 23:00", freq="1h")
    n_days = len(idx) // 24
    hour, month, doy = idx.hour.values, idx.month.values, idx.day_of_year.values
    day = np.repeat(np.arange(n_days), 24)

    # irradiance: clear sky x daily cloudiness (0.25 overcast .. 1 clear) x small hourly flicker
    cloud = rng.beta(4, 1.6, n_days) * 0.75 + 0.25
    ghi = clear_sky_ghi(idx, lat_deg) * cloud[day] * rng.uniform(0.9, 1.0, len(idx))

    # temperature: annual + diurnal cycle + persistent daily weather anomaly
    anomaly = np.zeros(n_days)
    for d in range(1, n_days):
        anomaly[d] = 0.7 * anomaly[d - 1] + rng.normal(0, 1.5)
    t2m = (24 + 9 * np.sin(2 * np.pi * (doy - 110) / 365) + 5 * np.sin(2 * np.pi * (hour - 9) / 24)
           + anomaly[day])

    # baseline: hour x month shape, weekend dip, cooling/heating response, AR(1) noise
    shape = (1 + 0.20 * np.sin(2 * np.pi * (hour - 13) / 24) + 0.10 * np.cos(2 * np.pi * (hour - 20) / 12)
             + 0.05 * np.sin(2 * np.pi * month / 12))
    weekend = (idx.day_of_week.values >= 5)
    eps = np.zeros(len(idx))
    shocks = rng.normal(0, noise_sd * base_mw, len(idx))
    for i in range(1, len(idx)):
        eps[i] = 0.6 * eps[i - 1] + shocks[i]
    baseline = (base_mw * shape * np.where(weekend, 0.92, 1.0) + 25 * np.clip(t2m - 18, 0, None)
                + 15 * np.clip(18 - t2m, 0, None) + eps)

    pv = capacity_mw * ghi / 1000 * PERFORMANCE_RATIO
    return pd.DataFrame({"net_load_mw": baseline - pv, "ghi": ghi, "t2m": t2m, "pv_mw": pv,
                         "baseline_mw": baseline}, index=idx)


@pytest.fixture(scope="session")
def synth_year() -> pd.DataFrame:
    return make_synthetic_year(seed=0)


@pytest.fixture(scope="session")
def make_year():
    """Factory for other seeds / capacities: make_year(seed=1, capacity_mw=50)."""
    return make_synthetic_year


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return ROOT


@pytest.fixture(scope="session")
def planted_capacity_mw() -> float:
    """Effective capacity (MW at 1000 W/m2) of the planted PV: 400 MW DC x 0.8."""
    return 400.0 * PERFORMANCE_RATIO

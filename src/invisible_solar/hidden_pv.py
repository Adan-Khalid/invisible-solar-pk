"""Estimating behind-the-meter (hidden) rooftop PV from a net-load series and a
public irradiance proxy.

Two estimators are implemented:

1. IRR - Irradiance-Residual Regression (linear, interpretable).
   net_load_t = baseline(hour x month, day type, temperature) - beta_m * GHI_t + e_t
   Identification comes from within-hour-of-day, within-month variation in
   irradiance (cloudy vs sunny days). beta_m (MW per W/m2) times 1000 W/m2 is an
   estimate of effective installed PV capacity in month m. PV_hat = beta_m * GHI.

2. CFI - Counterfactual-Irradiance gradient boosting (non-linear).
   Fit f(X, GHI) with LightGBM, then PV_hat = f(X, GHI=0) - f(X, GHI=observed).
   The model is never shown the PV series; it only sees net load.

Both use nothing a distribution company does not already have: its own net load
and free satellite/reanalysis irradiance (NASA POWER).
"""
from __future__ import annotations
import numpy as np
import pandas as pd
from dataclasses import dataclass
from .features import calendar_frame, degree_terms
from . import metrics as M


def _design(df: pd.DataFrame, temp_col: str, country: str | None):
    cal = calendar_frame(df.index, country)
    # drop_first: the constant added in fit_irr stands in for the omitted hour x month cell, so the
    # design is full rank (the full dummy set plus a constant is collinear)
    X = pd.get_dummies(cal["hour"].astype(str) + "_" + cal["month"].astype(str), prefix="hm", dtype=float, drop_first=True)
    X["weekend"] = cal["weekend"].values
    X["holiday"] = cal["holiday"].values
    dt = degree_terms(df[temp_col])
    X["cdd"] = dt["cdd"].values
    X["hdd"] = dt["hdd"].values
    X["cdd2"] = X["cdd"] ** 2
    X["hdd2"] = X["hdd"] ** 2
    # thermal inertia: mean temperature over the previous 24 h
    t24 = df[temp_col].rolling(24, min_periods=6).mean().bfill()
    dt24 = degree_terms(t24)
    X["cdd24"] = dt24["cdd"].values
    X["hdd24"] = dt24["hdd"].values
    # temperature effect differs by hour block
    for blk, (a, b) in {"day": (8, 18), "eve": (18, 23)}.items():
        m = ((cal["hour"] >= a) & (cal["hour"] < b)).astype(float).values
        X[f"cdd_{blk}"] = X["cdd"] * m
        X[f"hdd_{blk}"] = X["hdd"] * m
    X.index = df.index
    return X


def _season_basis(index: pd.DatetimeIndex, order: int = 2) -> np.ndarray:
    """Annual Fourier basis [1, sin, cos, sin2, cos2] for a smooth seasonal PV coefficient."""
    doy = index.dayofyear.values
    cols = [np.ones(len(index))]
    for k in range(1, order + 1):
        cols += [np.sin(2 * np.pi * k * doy / 365.25), np.cos(2 * np.pi * k * doy / 365.25)]
    return np.column_stack(cols)


@dataclass
class IRRResult:
    season_coef: np.ndarray         # coefficients of the Fourier basis for beta(doy), MW per (W/m2)
    pv_hat: pd.Series               # MW, in-sample
    beta_by_month: pd.Series        # mean beta(doy) per month, MW per (W/m2)
    capacity_mw_by_month: pd.Series # beta * 1000 W/m2 = effective capacity
    r2_fit: float
    order: int = 2


def _beta_of_time(coef, index, order):
    return np.clip(_season_basis(index, order) @ coef, 0, None)


def fit_irr(df: pd.DataFrame, load_col="net_load_mw", ghi_col="ghi", temp_col="t2m",
            country: str | None = None, order: int = 2) -> IRRResult:
    """IRR with a smooth seasonal PV coefficient beta(doy) = Fourier series (order 2).
    The smooth beta lets predict_irr interpolate between fitted months; extrapolating to a
    season the fit has not seen is unreliable (blocked half-year tests range widely)."""
    import statsmodels.api as sm
    X = _design(df, temp_col, country)
    B = _season_basis(df.index, order)
    ghi = df[ghi_col].values
    gcols = []
    for j in range(B.shape[1]):
        X[f"ghi_b{j}"] = ghi * B[:, j]
        gcols.append(f"ghi_b{j}")
    Xc = sm.add_constant(X, has_constant="add")
    res = sm.OLS(df[load_col].values, Xc.values.astype(float)).fit()
    coef = pd.Series(res.params, index=Xc.columns)
    season_coef = -coef[gcols].values
    beta_t = _beta_of_time(season_coef, df.index, order)
    pv_hat = pd.Series(beta_t * ghi, index=df.index).clip(lower=0)
    beta_m = pd.Series(beta_t, index=df.index).groupby(df.index.month).mean().reindex(range(1, 13))
    return IRRResult(season_coef, pv_hat, beta_m, beta_m * 1000, float(res.rsquared), order)


def predict_irr(res: IRRResult, df: pd.DataFrame, ghi_col="ghi") -> pd.Series:
    beta_t = _beta_of_time(res.season_coef, df.index, res.order)
    return pd.Series(beta_t * df[ghi_col].values, index=df.index).clip(lower=0)


def fit_cfi(df: pd.DataFrame, load_col="net_load_mw", ghi_col="ghi", temp_col="t2m",
            country: str | None = None, seed: int = 0):
    """Counterfactual-irradiance estimator with LightGBM. Returns (model, feature_fn)."""
    import lightgbm as lgb
    cal = calendar_frame(df.index, country)
    dt = degree_terms(df[temp_col])

    def feats(d):
        c = calendar_frame(d.index, country)
        t = degree_terms(d[temp_col])
        F = pd.DataFrame({
            "hour": c["hour"], "dow": c["dow"], "month": c["month"], "weekend": c["weekend"],
            "holiday": c["holiday"], "sin_d": c["sin_d"], "cos_d": c["cos_d"],
            "t2m": d[temp_col].values, "cdd": t["cdd"].values, "hdd": t["hdd"].values,
            "ghi": d[ghi_col].values,
        }, index=d.index)
        return F

    F = feats(df)
    model = lgb.LGBMRegressor(n_estimators=600, learning_rate=0.03, num_leaves=31, min_child_samples=40,
                              subsample=0.8, colsample_bytree=0.9, random_state=seed, verbose=-1)
    # monotone constraint: net load must not increase with irradiance
    model.set_params(monotone_constraints=[0] * (F.shape[1] - 1) + [-1])
    model.fit(F, df[load_col].values)
    return model, feats


def predict_cfi(model, feats, df: pd.DataFrame) -> pd.Series:
    F = feats(df)
    F0 = F.copy(); F0["ghi"] = 0.0
    pv_hat = model.predict(F0) - model.predict(F)
    return pd.Series(pv_hat, index=df.index).clip(lower=0)


def evaluate_pv(pv_true: pd.Series, pv_hat: pd.Series) -> dict:
    a, b = pv_true.align(pv_hat, join="inner")
    day = a > 0
    return {
        "energy_recovery_pct": float(b.sum() / a.sum() * 100),
        "r2_hourly": M.r2(a, b),
        "nrmse_daylight_pct": M.nrmse(a[day], b[day]),
        "corr_hourly": float(np.corrcoef(a, b)[0, 1]),
        "corr_daylight": float(np.corrcoef(a[day], b[day])[0, 1]),
        "r2_daylight": M.r2(a[day], b[day]),
        "peak_true_mw": float(a.max()), "peak_hat_mw": float(b.max()),
    }


def implied_capacity_from_truth(pv_true: pd.Series, ghi: pd.Series) -> float:
    """Effective capacity (MW at 1000 W/m2) implied by regressing true PV on GHI through the origin."""
    a, g = pv_true.align(ghi, join="inner")
    m = (g > 50)
    k = float((a[m] * g[m]).sum() / (g[m] ** 2).sum())
    return k * 1000


# ---------------------------------------------------------------------------
# Daily-energy IRR: robust to noisy irradiance proxies
# ---------------------------------------------------------------------------
def fit_irr_daily(df: pd.DataFrame, load_col="net_load_mw", ghi_col="ghi", temp_col="t2m",
                  country: str | None = None, order: int = 2) -> IRRResult:
    """Two-step estimator. Step 1 regresses DAILY net energy on day-type, degree-days and
    daily irradiance (with a smooth seasonal coefficient); daily proxy errors are much
    smaller than hourly ones, so the attenuation (errors-in-variables) bias that shrinks
    the hourly coefficient is reduced. Step 2 distributes the daily PV estimate across
    hours in proportion to hourly irradiance."""
    import statsmodels.api as sm
    cal = calendar_frame(df.index, country)
    day = pd.DataFrame({
        "load": df[load_col].resample("1D").sum(min_count=20),
        "ghi": df[ghi_col].resample("1D").sum(min_count=20),
        "cdd": degree_terms(df[temp_col])["cdd"].resample("1D").sum(min_count=20),
        "hdd": degree_terms(df[temp_col])["hdd"].resample("1D").sum(min_count=20),
        "weekend": cal["weekend"].resample("1D").max(),
        "holiday": cal["holiday"].resample("1D").max(),
    }).dropna()
    X = pd.get_dummies(day.index.month.astype(str), prefix="m", dtype=float, drop_first=True); X.index = day.index
    X["weekend"] = day["weekend"].values; X["holiday"] = day["holiday"].values
    X["cdd"] = day["cdd"].values; X["hdd"] = day["hdd"].values
    X["cdd2"] = X["cdd"] ** 2; X["hdd2"] = X["hdd"] ** 2
    B = _season_basis(day.index, order)
    gcols = []
    for j in range(B.shape[1]):
        X[f"ghi_b{j}"] = day["ghi"].values * B[:, j]; gcols.append(f"ghi_b{j}")
    Xc = sm.add_constant(X, has_constant="add")
    res = sm.OLS(day["load"].values, Xc.values.astype(float)).fit()
    coef = pd.Series(res.params, index=Xc.columns)
    season_coef = -coef[gcols].values
    beta_t = _beta_of_time(season_coef, df.index, order)
    pv_hat = pd.Series(beta_t * df[ghi_col].values, index=df.index).clip(lower=0)
    beta_m = pd.Series(beta_t, index=df.index).groupby(df.index.month).mean().reindex(range(1, 13))
    return IRRResult(season_coef, pv_hat, beta_m, beta_m * 1000, float(res.rsquared), order)

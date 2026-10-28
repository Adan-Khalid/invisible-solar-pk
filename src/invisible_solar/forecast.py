"""Day-ahead hourly net-load forecasting benchmark.

Setting: at the end of day d-1 we forecast all 24 hours of day d. Lags are therefore
>= 24 h. Weather inputs for day d use observed values (perfect-forecast assumption,
stated in the report). Models:
  - seasonal naive: same hour, 7 days earlier
  - LightGBM  (calendar + lags + temperature)                      "no-solar"
  - LightGBM + satellite GHI                                        "solar-aware"
  - LightGBM + GHI + hidden-PV term from the IRR estimator          "hidden-PV-aware"
Point metrics: MAPE, nRMSE, under-prediction rate. Probabilistic: quantile models at
q10/q50/q90, pinball loss, 80% interval coverage.
"""
from __future__ import annotations
import numpy as np
import pandas as pd
import lightgbm as lgb
from .features import calendar_frame, degree_terms
from . import metrics as M

LAGS = (24, 48, 168)


def build_features(df: pd.DataFrame, y_col: str, temp_col="t2m", ghi_col="ghi", pv_col=None, country=None) -> pd.DataFrame:
    c = calendar_frame(df.index, country)
    dt = degree_terms(df[temp_col])
    F = pd.DataFrame({"hour": c["hour"], "dow": c["dow"], "month": c["month"], "weekend": c["weekend"], "holiday": c["holiday"],
                      "sin_d": c["sin_d"], "cos_d": c["cos_d"], "t2m": df[temp_col].values, "cdd": dt["cdd"].values, "hdd": dt["hdd"].values}, index=df.index)
    for L in LAGS:
        F[f"lag{L}"] = df[y_col].shift(L).values
    F["lag24_mean7d"] = df[y_col].shift(24).rolling(24 * 7).mean().values
    if ghi_col:
        F["ghi"] = df[ghi_col].values
    if pv_col:
        F["pv_hat"] = df[pv_col].values
    return F


def _fit(F, y, objective="regression", alpha=None, seed=0):
    params = dict(n_estimators=800, learning_rate=0.03, num_leaves=31, min_child_samples=30, subsample=0.8,
                  subsample_freq=1, colsample_bytree=0.9, random_state=seed, verbose=-1, objective=objective)
    if alpha is not None:
        params["alpha"] = alpha
    m = lgb.LGBMRegressor(**params)
    m.fit(F, y)
    return m


def run_benchmark(df: pd.DataFrame, y_col: str, split_date: str, temp_col="t2m", ghi_col="ghi", pv_col=None, country=None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Returns (metrics table, predictions frame on the test period)."""
    specs = {
        "Seasonal naive (t-168h)": None,
        "LightGBM, no solar input": dict(ghi_col=None, pv_col=None),
        "LightGBM + satellite GHI": dict(ghi_col=ghi_col, pv_col=None),
    }
    if pv_col:
        specs["LightGBM + GHI + hidden-PV estimate"] = dict(ghi_col=ghi_col, pv_col=pv_col)
    y = df[y_col]
    test = df.index >= pd.Timestamp(split_date)
    preds = pd.DataFrame({"actual": y[test]})
    rows = []
    for name, sp in specs.items():
        if sp is None:
            p = y.shift(168)[test]
            lo = hi = None
        else:
            F = build_features(df, y_col, temp_col, country=country, **sp)
            ok = F.notna().all(axis=1) & y.notna()
            tr = ok & ~test
            m50 = _fit(F[tr], y[tr])
            p = pd.Series(m50.predict(F[test & ok]), index=F.index[test & ok]).reindex(y[test].index)
            q10 = _fit(F[tr], y[tr], "quantile", 0.1); q90 = _fit(F[tr], y[tr], "quantile", 0.9)
            lo = pd.Series(q10.predict(F[test & ok]), index=F.index[test & ok]).reindex(y[test].index)
            hi = pd.Series(q90.predict(F[test & ok]), index=F.index[test & ok]).reindex(y[test].index)
        preds[name] = p
        a = preds["actual"]; mask = a.notna() & p.notna()
        r = {"model": name, "MAPE_%": M.mape(a[mask], p[mask]), "nRMSE_%": M.nrmse(a[mask], p[mask]), "MAE": M.mae(a[mask], p[mask]),
             "under_prediction_%": M.under_prediction_rate(a[mask], p[mask])}
        if lo is not None:
            mm = mask & lo.notna() & hi.notna()
            r["pinball_q10"] = M.pinball(a[mm], lo[mm], 0.1); r["pinball_q90"] = M.pinball(a[mm], hi[mm], 0.9)
            r["coverage_80_%"] = M.coverage(a[mm], lo[mm], hi[mm])
            preds[name + " q10"] = lo; preds[name + " q90"] = hi
        rows.append(r)
    return pd.DataFrame(rows), preds

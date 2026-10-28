"""Smoke test of the day-ahead benchmark harness on four synthetic weeks (structure, not skill)."""
import numpy as np

from invisible_solar import forecast as F


def test_build_features_lags_are_day_ahead(synth_year):
    df = synth_year.iloc[: 24 * 10]
    X = F.build_features(df, "net_load_mw", pv_col="pv_mw")
    assert min(F.LAGS) >= 24  # nothing from the forecast day itself
    assert X["lag24"].iloc[30] == df["net_load_mw"].iloc[6]
    assert X["lag168"].iloc[:168].isna().all()
    assert {"ghi", "pv_hat"} <= set(X.columns)
    assert "ghi" not in F.build_features(df, "net_load_mw", ghi_col=None).columns


def test_run_benchmark_table_and_predictions(synth_year):
    df = synth_year.loc["2023-01-01":"2023-01-28"]
    table, preds = F.run_benchmark(df, "net_load_mw", "2023-01-22", pv_col="pv_mw", country="AU")
    assert table["model"].tolist() == ["Seasonal naive (t-168h)", "LightGBM, no solar input",
                                       "LightGBM + satellite GHI", "LightGBM + GHI + hidden-PV estimate"]
    assert len(preds) == 7 * 24 and preds.notna().all().all()
    assert (table["MAPE_%"] > 0).all() and (table["MAPE_%"] < 20).all()
    cov = table["coverage_80_%"].dropna()
    assert len(cov) == 3 and ((cov >= 0) & (cov <= 100)).all()
    assert np.isnan(table.loc[0, "coverage_80_%"])  # the naive model has no interval

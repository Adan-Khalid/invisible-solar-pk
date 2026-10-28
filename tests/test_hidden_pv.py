"""The IRR estimator on a synthetic year with PV of known size planted behind the meter.

Why these bands: the GHI the estimator sees is exactly the GHI that generated the PV and the
synthetic baseline lies (almost) in the span of the IRR design (hour x month cells, weekend,
degree terms), so OLS on the irradiance terms is unbiased and only the AR(1) load noise and
the weekend-shape misfit move the estimate. Over seeds 0-9 the in-sample energy recovery was
93-102 %, odd/even-month held-out 92-104 % and the daily-energy variant 91-105 %, so +/-10 %
(hourly) and +/-15 % (daily) leave a margin without hiding a real regression. The real-data
gaps (74-103 % on AEMO) come from what this toy cannot contain: proxy error in satellite GHI
and weather that drives both sunshine and load.
"""
import warnings

import numpy as np
import pandas as pd
import pytest
from statsmodels.tools.sm_exceptions import SingularMatrixWarning

from invisible_solar import hidden_pv as H

COUNTRY = "AU"  # any calendar with holidays works; AU builds instantly (PK takes ~2 s per call).
# With country=None the holiday column is all zeros (see the xfail below).


@pytest.fixture(scope="module")
def irr_fit(synth_year):
    return H.fit_irr(synth_year, country=COUNTRY)


def test_fit_irr_recovers_planted_energy(synth_year, irr_fit):
    ev = H.evaluate_pv(synth_year["pv_mw"], irr_fit.pv_hat)
    assert 90 <= ev["energy_recovery_pct"] <= 110
    assert ev["corr_hourly"] > 0.9
    assert ev["corr_daylight"] > 0.9


def test_fit_irr_capacity_close_to_planted(irr_fit, planted_capacity_mw):
    cap = irr_fit.capacity_mw_by_month
    assert cap.index.tolist() == list(range(1, 13))
    assert cap.notna().all()
    assert abs(cap.mean() / planted_capacity_mw - 1) <= 0.25
    assert ((cap / planted_capacity_mw - 1).abs() <= 0.25).all()
    np.testing.assert_allclose(irr_fit.capacity_mw_by_month, irr_fit.beta_by_month * 1000)


def test_fit_irr_outputs_are_physical(synth_year, irr_fit):
    assert (irr_fit.pv_hat >= 0).all()
    assert (irr_fit.pv_hat[synth_year["ghi"] == 0] == 0).all()  # no PV at night
    assert irr_fit.pv_hat.index.equals(synth_year.index)
    assert 0 < irr_fit.r2_fit <= 1
    assert irr_fit.season_coef.shape == (2 * irr_fit.order + 1,)


def test_predict_irr_on_held_out_months(synth_year):
    odd = synth_year.index.month % 2 == 1
    train, test = synth_year[odd], synth_year[~odd]
    res = H.fit_irr(train, country=COUNTRY)
    pv_hat = H.predict_irr(res, test)
    assert pv_hat.index.equals(test.index)
    ev = H.evaluate_pv(test["pv_mw"], pv_hat)
    assert 90 <= ev["energy_recovery_pct"] <= 110
    assert ev["corr_hourly"] > 0.9


def test_predict_irr_in_sample_matches_fit(synth_year, irr_fit):
    pd.testing.assert_series_equal(H.predict_irr(irr_fit, synth_year), irr_fit.pv_hat)


def test_fit_irr_daily_recovers(synth_year, planted_capacity_mw):
    res = H.fit_irr_daily(synth_year, country=COUNTRY)
    ev = H.evaluate_pv(synth_year["pv_mw"], res.pv_hat)
    assert 85 <= ev["energy_recovery_pct"] <= 115
    assert ev["corr_hourly"] > 0.9
    assert abs(res.capacity_mw_by_month.mean() / planted_capacity_mw - 1) <= 0.25


def test_design_is_full_rank_no_singular_warning(synth_year):
    """Regression test for the old full-dummy-set + constant design (rank-deficient)."""
    X = H._design(synth_year, "t2m", COUNTRY)
    assert np.linalg.matrix_rank(X.values.astype(float)) == X.shape[1]
    with warnings.catch_warnings():
        warnings.simplefilter("error", SingularMatrixWarning)
        H.fit_irr_daily(synth_year, country=COUNTRY)


@pytest.mark.xfail(raises=SingularMatrixWarning, strict=True,
                   reason="known: without a country the holiday column is all zeros, so the design "
                          "is rank-deficient (pinv still returns the minimum-norm fit)")
def test_fit_without_country_is_rank_deficient(synth_year):
    H.fit_irr_daily(synth_year, country=None)


def test_evaluate_pv_hand_example():
    idx = pd.date_range("2024-01-01", periods=6, freq="1h")
    true = pd.Series([0, 0, 2, 4, 2, 0], index=idx, dtype=float)
    hat = pd.Series([0, 1, 1, 4, 3, 0], index=idx, dtype=float)
    ev = H.evaluate_pv(true, hat)
    assert set(ev) == {"energy_recovery_pct", "r2_hourly", "nrmse_daylight_pct", "corr_hourly",
                       "corr_daylight", "r2_daylight", "peak_true_mw", "peak_hat_mw"}
    assert ev["energy_recovery_pct"] == pytest.approx(9 / 8 * 100)
    assert ev["r2_hourly"] == pytest.approx(1 - 3 / (120 / 9))
    assert ev["corr_hourly"] == pytest.approx(2 / np.sqrt(5))
    # daylight = hours with true PV > 0: true [2, 4, 2] vs hat [1, 4, 3]
    assert ev["corr_daylight"] == pytest.approx(np.sqrt(4 / 7))
    assert ev["r2_daylight"] == pytest.approx(0.25)
    assert ev["nrmse_daylight_pct"] == pytest.approx(np.sqrt(2 / 3) / (8 / 3) * 100)
    assert ev["peak_true_mw"] == 4 and ev["peak_hat_mw"] == 4


def test_evaluate_pv_aligns_on_common_index():
    idx = pd.date_range("2024-01-01", periods=4, freq="1h")
    true = pd.Series([1.0, 2.0, 3.0, 4.0], index=idx)
    hat = pd.Series([1.0, 2.0, 3.0, 4.0, 100.0], index=idx.append(pd.DatetimeIndex(["2024-01-02"])))
    assert H.evaluate_pv(true, hat)["energy_recovery_pct"] == pytest.approx(100)


def test_implied_capacity_from_truth(synth_year, planted_capacity_mw):
    assert H.implied_capacity_from_truth(synth_year["pv_mw"], synth_year["ghi"]) == pytest.approx(planted_capacity_mw)


def test_implied_capacity_ignores_low_irradiance_hours():
    ghi = pd.Series([0, 20, 50, 200, 600, 1000], dtype=float)
    pv = 0.5 * ghi
    pv.iloc[1] = 99.0  # junk at GHI <= 50 W/m2 must not matter
    pv.iloc[2] = 99.0
    assert H.implied_capacity_from_truth(pv, ghi) == pytest.approx(500.0)


def test_cfi_counterfactual_is_zero_at_night_and_tracks_pv(synth_year):
    """Sanity check of the LightGBM counterfactual estimator (not a performance claim: on this
    toy it shrinks the PV, ~70 % of planted energy, but keeps its shape)."""
    q = synth_year.loc["2023-01-01":"2023-03-31"]
    model, feats = H.fit_cfi(q, country=COUNTRY)
    pv_hat = H.predict_cfi(model, feats, q)
    assert (pv_hat >= 0).all()
    assert (pv_hat[q["ghi"] == 0] == 0).all()  # same features with GHI already 0 -> no difference
    ev = H.evaluate_pv(q["pv_mw"], pv_hat)
    assert ev["corr_hourly"] > 0.9
    assert 50 <= ev["energy_recovery_pct"] <= 120

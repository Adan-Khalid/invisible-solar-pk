"""Hand-computed examples for the forecast and estimator metrics."""
import numpy as np
import pandas as pd
import pytest

from invisible_solar import metrics as M
from invisible_solar.features import calendar_frame, degree_terms


def test_mape_skips_zero_actuals():
    assert M.mape([100, 200, 0], [110, 180, 5]) == pytest.approx(10.0)


def test_nrmse_is_rmse_over_mean():
    assert M.nrmse([1, 2, 3], [1, 2, 5]) == pytest.approx(np.sqrt(4 / 3) / 2 * 100)


def test_mae():
    assert M.mae([1, 2, 3], [2, 2, 1]) == pytest.approx(1.0)


def test_r2_perfect_and_mean_forecast():
    assert M.r2([1, 2, 3], [1, 2, 3]) == pytest.approx(1.0)
    assert M.r2([1, 2, 3], [2, 2, 2]) == pytest.approx(0.0)


def test_pinball_is_asymmetric():
    assert M.pinball([10], [8], 0.9) == pytest.approx(1.8)   # under-forecast costs q
    assert M.pinball([10], [12], 0.9) == pytest.approx(0.2)  # over-forecast costs 1-q


def test_coverage_counts_inclusive_bounds():
    assert M.coverage([1, 2, 3, 4], [0, 2.5, 0, 5], [2, 3, 4, 6]) == pytest.approx(50.0)
    assert M.coverage([2], [2], [2]) == pytest.approx(100.0)


def test_under_prediction_rate():
    assert M.under_prediction_rate([1, 2, 3, 4], [0, 2, 4, 3]) == pytest.approx(50.0)


def test_degree_terms_split_at_base():
    dt = degree_terms(pd.Series([10.0, 18.0, 25.0]))
    assert dt["cdd"].tolist() == [0, 0, 7]
    assert dt["hdd"].tolist() == [8, 0, 0]


def test_calendar_frame_weekend_and_holiday():
    idx = pd.date_range("2024-01-26", periods=72, freq="1h")  # Fri (Australia Day) .. Sun
    cal = calendar_frame(idx, "AU")
    assert cal["weekend"].groupby(idx.date).max().tolist() == [0, 1, 1]
    assert cal["holiday"].groupby(idx.date).max().tolist() == [1, 0, 0]
    assert calendar_frame(idx)["holiday"].sum() == 0

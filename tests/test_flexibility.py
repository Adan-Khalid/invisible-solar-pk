"""Profile metrics, battery sizing and cooling flexibility on hand-built days whose answers can
be worked out on paper (the documented contracts in invisible_solar.flexibility)."""
import numpy as np
import pandas as pd
import pytest

from invisible_solar import flexibility as F

HOURS = range(1, 25)  # NEPRA hour labels


def day(values) -> pd.Series:
    return pd.Series(values, index=HOURS, dtype=float)


# A duck-shaped day: early dip at 5, morning hump at 9, midday trough at 13, afternoon bump at 16,
# dusk trough at 18, evening peak at 21.
DUCK = day([100, 98, 96, 95, 90, 92, 100, 110, 120, 115, 105, 90,
            80, 85, 95, 110, 105, 100, 130, 150, 160, 150, 130, 110])


# ---------------------------------------------------------------- profile_metrics
def test_profile_metrics_duck_day_by_hand():
    m = F.profile_metrics(DUCK)
    assert (m["day_max_mw"], m["day_max_hour"], m["day_min_mw"], m["day_min_hour"]) == (160, 21, 80, 13)
    assert (m["midday_min_mw"], m["midday_min_hour"]) == (80, 13)
    assert (m["evening_peak_mw"], m["evening_peak_hour"]) == (160, 21)
    assert m["evening_ramp_mw"] == 80 and m["evening_ramp_mw_per_h"] == 10  # 80 MW over hours 13 -> 21
    assert m["evening_is_day_peak"] is True
    assert (m["afternoon_max_mw"], m["afternoon_max_hour"], m["dusk_min_mw"], m["dusk_min_hour"]) == (110, 16, 100, 18)
    assert m["dusk_drop_mw"] == 10
    assert (m["night_peak_mw"], m["night_peak_hour"], m["night_rise_mw"]) == (160, 21, 60)
    assert (m["early_min_mw"], m["early_min_hour"], m["morning_peak_mw"], m["morning_peak_hour"]) == (90, 5, 120, 9)
    assert m["morning_rise_mw"] == 30
    assert (m["steepest_3h_ramp_mw"], m["steepest_3h_start_hour"]) == (60, 18)  # 100 at 18 -> 160 at 21
    assert m["daily_energy_mwh"] == pytest.approx(DUCK.sum())
    assert m["load_factor"] == pytest.approx(DUCK.mean() / 160)


def test_profile_metrics_ignores_input_order():
    assert F.profile_metrics(DUCK.iloc[::-1]) == F.profile_metrics(DUCK)


def test_profile_metrics_falling_day_has_no_evening_ramp():
    m = F.profile_metrics(day(np.linspace(200, 100, 24)))
    assert m["midday_min_hour"] == 17 and m["evening_peak_hour"] == 17
    assert m["evening_ramp_mw"] == 0 and np.isnan(m["evening_ramp_mw_per_h"])
    assert m["evening_is_day_peak"] is False


@pytest.mark.parametrize("index", [range(0, 24), range(1, 24)])
def test_profile_metrics_rejects_other_hour_labels(index):
    with pytest.raises(ValueError, match="1..24"):
        F.profile_metrics(pd.Series(100.0, index=index))


# ---------------------------------------------------------------- storage_to_shave
def flat_with_peaks(peak_hours, base=100.0, peak=200.0) -> pd.Series:
    return day([peak if h in peak_hours else base for h in HOURS])


def test_storage_two_adjacent_peak_hours():
    """Cap 150 on a 100 MW day with 200 MW at hours 19-20: 50 MW for two hours in a row, and no
    chance to recharge in between, so the battery must hold all 100 MWh."""
    r = F.storage_to_shave(flat_with_peaks({19, 20}), cap_frac=0.75)
    assert (r["cap_mw"], r["power_mw"], r["energy_mwh"], r["hours_above_cap"]) == (150, 50, 100, 2)
    assert r["charge_headroom_mwh"] == 22 * 50  # 22 hours with 50 MW of room, power-limited to 50
    assert r["feasible"] is True
    assert r["min_storage_mwh"] == pytest.approx(100, rel=1e-6)


def test_storage_separated_peaks_recharge_in_between():
    r = F.storage_to_shave(flat_with_peaks({12, 20}), cap_frac=0.75)
    assert r["energy_mwh"] == 100 and r["feasible"] is True
    assert r["min_storage_mwh"] == pytest.approx(50, rel=1e-6)  # refilled (0.9 x 50 MW/h) between peaks


def test_storage_peak_at_end_of_day_recharges_next_morning():
    """The day repeats: a battery emptied at hours 23-24 refills during the following day."""
    r = F.storage_to_shave(flat_with_peaks({23, 24}), cap_frac=0.75)
    assert r["feasible"] is True
    assert r["min_storage_mwh"] == pytest.approx(100, rel=1e-6)


def test_storage_min_cap_fraction_by_hand():
    """Cap c in [100, 150]: 22 hours x 0.9 x (c - 100) of charging must cover 2 x (200 - c) of
    discharge, so c >= 2380 / 21.8; above 150 the power limit 200 - c never binds the balance."""
    r = F.storage_to_shave(flat_with_peaks({19, 20}), cap_frac=0.75)
    expected = 2380 / 21.8 / 200
    assert r["min_cap_frac"] == pytest.approx(expected, rel=1e-6)
    assert r["min_cap_frac_free_charge"] == pytest.approx(expected, rel=1e-6)


def test_storage_infeasible_cap():
    r = F.storage_to_shave(flat_with_peaks({19, 20}), cap_frac=0.5)  # cap = base load: no room to charge
    assert r["charge_headroom_mwh"] == 0 and r["feasible"] is False
    assert np.isnan(r["min_storage_mwh"])


def test_storage_cap_at_day_max_needs_nothing():
    r = F.storage_to_shave(DUCK, cap_frac=1.0)
    assert (r["power_mw"], r["energy_mwh"], r["hours_above_cap"], r["min_storage_mwh"]) == (0, 0, 0, 0)
    assert r["feasible"] is True


def test_storage_flat_day():
    r = F.storage_to_shave(day([100.0] * 24), cap_frac=0.9)
    assert r["feasible"] is False and r["min_cap_frac"] == 1.0 and r["min_cap_frac_free_charge"] == 1.0


def test_power_limit_can_bind():
    """One wide high block: with unlimited charging power a lower cap balances than with charging
    limited to the battery's discharge power."""
    s = day([100] * 6 + [300] * 12 + [100] * 6)
    r = F.storage_to_shave(s, cap_frac=0.9)
    assert r["min_cap_frac_free_charge"] < r["min_cap_frac"]


# ---------------------------------------------------------------- cooling
def hourly_index(days=3):
    return pd.date_range("2024-06-01", periods=24 * days, freq="1h")


def test_cooling_share_recovers_slope():
    idx = hourly_index()
    temp = pd.Series(20 + 15 * np.sin(np.linspace(0, 6 * np.pi, len(idx))) ** 2, index=idx)
    load = 2.0 + 0.5 * np.clip(temp - 24, 0, None)
    load.iloc[5] = np.nan  # gaps are dropped, not filled
    r = F.cooling_share(load, temp)
    assert r["kw_per_degC"] == pytest.approx(0.5)
    cdd = np.clip(temp - 24, 0, None).drop(idx[5])
    assert r["cooling_kwh"] == pytest.approx(0.5 * cdd.sum())
    assert r["total_kwh"] == pytest.approx(load.dropna().sum())
    assert r["cooling_share_pct"] == pytest.approx(r["cooling_kwh"] / r["total_kwh"] * 100)
    assert len(r["cooling_series"]) == len(idx) - 1


def test_cooling_share_never_negative():
    idx = hourly_index()
    temp = pd.Series(np.linspace(20, 40, len(idx)), index=idx)
    load = 10.0 - 0.2 * np.clip(temp - 24, 0, None)  # load falls in the heat
    r = F.cooling_share(load, temp)
    assert r["kw_per_degC"] == 0 and r["cooling_kwh"] == 0 and r["cooling_share_pct"] == 0


def test_precool_shift_evening_window():
    idx = hourly_index(days=2)
    level = np.where(idx.day == 1, 1.0, 2.0)
    cooling = pd.Series(np.where((idx.hour >= 17) & (idx.hour < 22), level, 0.0), index=idx)
    r = F.precool_shift(cooling)
    assert r["shiftable_kwh_per_day"] == pytest.approx((5 * 1 + 5 * 2) / 2)  # hours 17-21, both days
    assert r["evening_cooling_peak_kw"] == pytest.approx(1.5)

"""Daily-profile shape metrics, storage sizing and cooling-load flexibility.

Profile functions take one day of hourly demand indexed by NEPRA's printed hour labels 1..24
(NEPRA prints 1..24 or 01:00..24:00/0:00 and does not say whether a label is hour-ending or
instantaneous). All windows below are inclusive ranges of those labels, so every number can be
checked directly against the published tables."""
from __future__ import annotations
import numpy as np
import pandas as pd

MIDDAY = (12, 17)    # window searched for the midday minimum and the afternoon maximum
EVENING = (17, 24)   # window searched for the evening peak (label 24 is the last hour of the day)
DUSK = (18, 20)      # window searched for the evening trough
EARLY = (5, 10)      # window searched for the early-morning minimum
MORNING = (9, 16)    # window searched for the late-morning / afternoon maximum
RTE = 0.9            # battery round-trip efficiency, applied when charging
_GRID = 20_001       # caps tried between the day minimum and maximum before refining
_REL_TOL = 1e-9      # relative tolerance for energy balances (fraction of the day maximum / discharge)


def _day(s: pd.Series) -> pd.Series:
    s = s.astype(float).sort_index()
    if list(s.index) != list(range(1, 25)):
        raise ValueError("expected 24 hourly values labelled 1..24 (NEPRA hour labels)")
    return s


def _ext(s: pd.Series, lo: int, hi: int, fn: str) -> tuple[float, int]:
    w = s.loc[lo:hi]
    h = int(w.idxmax() if fn == "max" else w.idxmin())
    return float(w[h]), h


def profile_metrics(s: pd.Series) -> dict:
    """Shape of one day of hourly demand (MW) on hour labels 1..24.

    day_max / day_min        : extreme hour of the whole day.
    evening_ramp_mw          : max over hours 17-24 minus min over hours 12-17. Positive only when
                               demand rises from the midday window into the evening window;
                               evening_ramp_mw_per_h divides by the hours between the two (NaN if
                               the evening peak does not come after the midday minimum).
                               evening_is_day_peak says whether that evening value is the day's
                               maximum; if not, the "ramp" may be the tail of an afternoon peak.
    dusk_drop_mw             : max over hours 12-17 (afternoon_max) minus min over hours 18-20
                               (dusk_min, the evening trough). Negative if demand is higher at dusk.
    night_rise_mw            : max over the hours after the dusk trough up to label 24 (night_peak)
                               minus dusk_min. Negative if demand only falls after the trough.
    morning_rise_mw          : max over hours 9-16 minus min over hours 5-10.
    steepest_3h_ramp_mw      : max of s[h+3] - s[h] for h = 1..21 (start label h, end label h+3).
    load_factor              : mean / max of the day."""
    s = _day(s)
    out = {}
    out["day_max_mw"], out["day_max_hour"] = _ext(s, 1, 24, "max")
    out["day_min_mw"], out["day_min_hour"] = _ext(s, 1, 24, "min")
    out["midday_min_mw"], out["midday_min_hour"] = _ext(s, *MIDDAY, "min")
    out["evening_peak_mw"], out["evening_peak_hour"] = _ext(s, *EVENING, "max")
    out["evening_ramp_mw"] = out["evening_peak_mw"] - out["midday_min_mw"]
    dh = out["evening_peak_hour"] - out["midday_min_hour"]
    out["evening_ramp_mw_per_h"] = out["evening_ramp_mw"] / dh if dh > 0 else float("nan")
    out["evening_is_day_peak"] = bool(out["evening_peak_mw"] >= out["day_max_mw"])
    out["afternoon_max_mw"], out["afternoon_max_hour"] = _ext(s, *MIDDAY, "max")
    out["dusk_min_mw"], out["dusk_min_hour"] = _ext(s, *DUSK, "min")
    out["dusk_drop_mw"] = out["afternoon_max_mw"] - out["dusk_min_mw"]
    out["night_peak_mw"], out["night_peak_hour"] = _ext(s, out["dusk_min_hour"] + 1, 24, "max")
    out["night_rise_mw"] = out["night_peak_mw"] - out["dusk_min_mw"]
    out["early_min_mw"], out["early_min_hour"] = _ext(s, *EARLY, "min")
    out["morning_peak_mw"], out["morning_peak_hour"] = _ext(s, *MORNING, "max")
    out["morning_rise_mw"] = out["morning_peak_mw"] - out["early_min_mw"]
    d3 = (s.shift(-3) - s).loc[1:21]
    out["steepest_3h_ramp_mw"], out["steepest_3h_start_hour"] = float(d3.max()), int(d3.idxmax())
    out["daily_energy_mwh"] = float(s.sum())
    out["load_factor"] = float(s.mean() / s.max())
    return out


def _balance(v: np.ndarray, caps: np.ndarray, rte: float, power_limited: bool) -> np.ndarray:
    """For each cap: rte * (energy that can be charged below the cap) - (energy above the cap).
    With power_limited, charging in each hour is limited to the battery power, i.e. the largest
    hourly excess over that cap."""
    gap = caps[:, None] - v[None, :]
    excess = np.clip(-gap, 0.0, None)
    room = np.clip(gap, 0.0, None)
    if power_limited:
        room = np.minimum(room, excess.max(axis=1, keepdims=True))
    return rte * room.sum(axis=1) - excess.sum(axis=1)


def _min_cap_frac(v: np.ndarray, rte: float, power_limited: bool) -> float:
    """Lowest cap c (as a fraction of the day maximum) such that every cap from c up to the day
    maximum passes the within-day energy balance. Grid search between the day minimum and maximum,
    then bisection inside the last failing grid step."""
    peak, low = float(v.max()), float(v.min())
    if peak <= low:
        return 1.0
    tol = _REL_TOL * peak
    caps = np.linspace(low, peak, _GRID)
    bad = np.flatnonzero(_balance(v, caps, rte, power_limited) < -tol)
    if bad.size == 0:
        return float(low / peak)
    lo, hi = caps[bad[-1]], caps[bad[-1] + 1]  # the balance is 0 at the day maximum, so hi exists
    for _ in range(60):
        c = (lo + hi) / 2
        if _balance(v, np.array([c]), rte, power_limited)[0] >= -tol:
            hi = c
        else:
            lo = c
    return float(hi / peak)


def _min_storage_mwh(excess: np.ndarray, room: np.ndarray, rte: float) -> float:
    """Smallest usable energy capacity for a battery that repeats the same day: it discharges the
    excess above the cap and can recharge at most `room` (grid energy) in each hour below it, storing
    rte * room. Charging whenever possible until full keeps the state of charge as high as any other
    schedule can, so a capacity works if and only if that greedy schedule, started full and repeated
    day after day until its start-of-day state settles, never runs empty. The smallest working
    capacity is found by bisection between 0 and the daily discharge (which always works when the
    day is feasible). Returns NaN if even the daily discharge does not work (infeasible day)."""
    need = float(excess.sum())
    if need <= 0:
        return 0.0
    empty_tol, settle_tol = 1e-12 * need, _REL_TOL * need  # rounding allowance; start-of-day convergence

    def works(capacity: float) -> bool:
        start = capacity
        for _ in range(100):  # settles in two or three days when the day is energy-feasible
            soc = start
            for d, r in zip(excess, room):
                soc = soc - d if d > 0 else min(capacity, soc + rte * r)
                if soc < -empty_tol:
                    return False
            if abs(soc - start) <= settle_tol:
                return True
            start = soc
        return False

    if not works(need):
        return float("nan")
    lo, hi = 0.0, need
    for _ in range(60):
        mid = (lo + hi) / 2
        if works(mid):
            hi = mid
        else:
            lo = mid
    return hi


def storage_to_shave(s: pd.Series, cap_frac: float, rte: float = RTE) -> dict:
    """Battery needed to hold one day of hourly demand at or below cap = cap_frac * day max.

    power_mw              : largest hourly excess over the cap (battery power rating).
    energy_mwh            : summed excess over the cap, i.e. the energy discharged per day. This is
                            an upper bound on the storage capacity needed, not the capacity itself.
    hours_above_cap       : number of hours with demand above the cap.
    charge_headroom_mwh   : room below the cap in the other hours, with charging limited to the
                            same power rating: sum over hours below the cap of min(cap - s, power).
    feasible              : rte * charge_headroom_mwh >= energy_mwh, i.e. the battery can be
                            refilled within the same (repeating) day without raising demand above
                            the cap. If False, the cap cannot be held day after day.
    min_storage_mwh       : smallest usable storage capacity that holds the cap when the same day
                            repeats (recharging between separate above-cap blocks, power-limited
                            charging, efficiency rte). NaN if not feasible. Equal to energy_mwh when
                            the battery cannot recharge between above-cap hours; smaller when it can.
    min_cap_frac          : lowest cap (fraction of day max) such that every cap from there up to the
                            day max is feasible in the sense above, with the battery power (and so the
                            charging limit) set by each cap.
    min_cap_frac_free_charge : the same with unlimited charging power. Where it is below
                            min_cap_frac, the charging-power limit, not the recharge energy, binds."""
    s = _day(s)
    v = s.to_numpy()
    peak = float(v.max())
    cap = cap_frac * peak
    excess = np.clip(v - cap, 0.0, None)
    power, energy = float(excess.max()), float(excess.sum())
    room = np.minimum(np.clip(cap - v, 0.0, None), power)
    headroom = float(room.sum())
    feasible = bool(_balance(v, np.array([cap]), rte, True)[0] >= -_REL_TOL * peak)
    return {"cap_frac": cap_frac, "cap_mw": cap, "power_mw": power, "energy_mwh": energy,
            "hours_above_cap": int((excess > 0).sum()), "charge_headroom_mwh": headroom,
            "feasible": feasible,
            "min_storage_mwh": _min_storage_mwh(excess, room, rte) if feasible else float("nan"),
            "min_cap_frac": _min_cap_frac(v, rte, True),
            "min_cap_frac_free_charge": _min_cap_frac(v, rte, False)}


def cooling_share(load: pd.Series, temp: pd.Series, base: float = 24.0) -> dict:
    """Temperature-sensitive (cooling) load via piecewise regression of hourly load on cooling degrees.
    Returns slope (kW per degC above base) and the implied cooling kWh share over the sample."""
    cdd = np.clip(temp - base, 0, None)
    m = ~(load.isna() | cdd.isna())
    x, y = cdd[m].values, load[m].values
    A = np.column_stack([np.ones_like(x), x])
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    slope = max(coef[1], 0.0)
    cooling = pd.Series(slope * x, index=load[m].index)
    return {"kw_per_degC": float(slope), "cooling_kwh": float(cooling.sum()), "total_kwh": float(y.sum()),
            "cooling_share_pct": float(cooling.sum() / y.sum() * 100), "cooling_series": cooling}


def precool_shift(cooling: pd.Series, shift_hours: int = 2, window=(17, 22)) -> dict:
    """Simple shiftable-load estimate: cooling energy in the evening window that could be
    pre-cooled `shift_hours` earlier (into solar hours). Returns kWh/day and peak kW reduction."""
    h = cooling.index.hour
    eve = cooling[(h >= window[0]) & (h < window[1])]
    daily = eve.groupby(eve.index.date).sum()
    peak_kw = eve.groupby(eve.index.date).max()
    return {"shiftable_kwh_per_day": float(daily.mean()), "evening_cooling_peak_kw": float(peak_kw.mean())}

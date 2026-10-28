"""Calendar and weather feature engineering shared by the estimator and the forecaster."""
import numpy as np
import pandas as pd

try:
    import holidays as _hol
except Exception:  # pragma: no cover
    _hol = None


def calendar_frame(index: pd.DatetimeIndex, country: str | None = None) -> pd.DataFrame:
    f = pd.DataFrame(index=index)
    f["hour"] = index.hour
    f["dow"] = index.dayofweek
    f["month"] = index.month
    f["doy"] = index.dayofyear
    f["weekend"] = (index.dayofweek >= 5).astype(int)
    f["holiday"] = 0
    if country and _hol is not None:
        # National public holidays only (no state/province subdivisions such as NSW or Punjab).
        years = sorted(set(index.year))
        hs = _hol.country_holidays(country, years=years)
        f["holiday"] = np.array([d in hs for d in index.date], dtype=int)
    f["sin_h"] = np.sin(2 * np.pi * f["hour"] / 24)
    f["cos_h"] = np.cos(2 * np.pi * f["hour"] / 24)
    f["sin_d"] = np.sin(2 * np.pi * f["doy"] / 365.25)
    f["cos_d"] = np.cos(2 * np.pi * f["doy"] / 365.25)
    return f


def degree_terms(temp: pd.Series, base: float = 18.0) -> pd.DataFrame:
    return pd.DataFrame({"cdd": np.clip(temp - base, 0, None), "hdd": np.clip(base - temp, 0, None)}, index=temp.index)

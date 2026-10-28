"""Loaders for every dataset used in the project. Raw files are not committed;
see data/README.md for download commands. All loaders return tidy pandas frames
with a tz-naive local-time DatetimeIndex unless stated."""
from __future__ import annotations
import glob
import pandas as pd
import numpy as np
from .config import DATA_DIR


def load_nasa_power(path) -> pd.DataFrame:
    """NASA POWER hourly CSV, stamps as published (hour-beginning). The hourly API's default
    "LST" is UTC + round(lon/15) h; use lst_to_clock to move it onto a fixed-offset clock.
    Returns t2m, rh2m, ghi, ghi_clear (Wh/m2 per hour). Raises ValueError naming the file when
    it has no data header line (e.g. the API saved a JSON error message under the CSV name)."""
    # the data table starts at the "YEAR,MO,DY,HR,..." line, after a free-text header block
    with open(path, encoding="utf-8", errors="replace") as f:
        hdr = next((i for i, line in enumerate(f) if line.startswith("YEAR,")), None)
    if hdr is None:
        raise ValueError(f"{path}: no NASA POWER data header (a line starting 'YEAR,'); the download "
                         "may be an API error message: re-download it (scripts/00_download_data.sh)")
    df = pd.read_csv(path, skiprows=hdr, encoding="utf-8", encoding_errors="replace")
    ts = pd.to_datetime(dict(year=df.YEAR, month=df.MO, day=df.DY, hour=df.HR))
    out = pd.DataFrame({
        "t2m": df["T2M"].values,
        "rh2m": df["RH2M"].values if "RH2M" in df else np.nan,
        "ghi": df["ALLSKY_SFC_SW_DWN"].values,
        "ghi_clear": df["CLRSKY_SFC_SW_DWN"].values if "CLRSKY_SFC_SW_DWN" in df else np.nan,
    }, index=pd.DatetimeIndex(ts))
    out = out.replace(-999.0, np.nan)
    return out


def aemo_halfhour_to_hourly(series: pd.Series) -> pd.Series:
    """AEMO stamps are interval-ENDING (AEST, UTC+10, no DST): the 30-min ROOFTOP_PV_ACTUAL
    value stamped 10:30 covers 10:00-10:30. Average them into hour-BEGINNING hours, so the
    10:00 hour is the mean of the 10:30 and 11:00 stamps. The same rule serves the 5-min
    dispatch demand in PRICE_AND_DEMAND."""
    return series.sort_index().resample("1h", label="left", closed="right").mean()


def _aemo_demand_files(region: str) -> list[str]:
    """The 2024 PRICE_AND_DEMAND monthly files of one region, sorted; FileNotFoundError naming the
    folder searched when there are none (pd.concat would only say 'No objects to concatenate')."""
    folder = DATA_DIR / "intl"
    pattern = f"aemo_PRICE_AND_DEMAND_2024*_{region}.csv"
    files = sorted(glob.glob(str(folder / pattern)))
    if not files:
        raise FileNotFoundError(f"no {pattern} in {folder}: download the raw data (data/README.md, "
                                "scripts/00_download_data.sh) or point INVISIBLE_SOLAR_DATA at it")
    return files


def load_aemo_nsw_2024() -> pd.DataFrame:
    """Hourly NSW1 operational demand (MW, net of rooftop PV), AEMO's rooftop-PV estimate (MW,
    ROOFTOP_PV_ACTUAL type MEASUREMENT), and NASA POWER weather for Sydney, all on the AEST
    clock (UTC+10, tz-naive)."""
    files = _aemo_demand_files("NSW1")
    d = pd.concat(pd.read_csv(f) for f in files)
    d["t"] = pd.to_datetime(d["SETTLEMENTDATE"])
    dem = aemo_halfhour_to_hourly(d.set_index("t")["TOTALDEMAND"])
    pv = pd.read_csv(DATA_DIR / "intl" / "aemo_rooftop_nsw1_2024_hourly.csv", index_col=0, parse_dates=True)["rooftop_pv_mw"]
    wx = load_nasa_power(DATA_DIR / "weather" / "nasa_power_hourly_sydney_2024.csv")
    df = pd.concat([dem.rename("net_load_mw"), pv.rename("pv_mw")], axis=1, sort=True).join(wx, how="inner")
    df["underlying_mw"] = df["net_load_mw"] + df["pv_mw"]
    return df.dropna(subset=["net_load_mw", "pv_mw", "ghi"])


def load_rewdp_hourly() -> pd.DataFrame:
    """Hourly mean kW per household (REWD-P, LUMS Energy Institute), Pakistan local time."""
    df = pd.read_csv(DATA_DIR / "pk" / "derived" / "rewdp_hourly_all.csv", parse_dates=["datetime"])
    return df


def load_rewdp_weather(city: str) -> pd.DataFrame:
    p = DATA_DIR / "pk" / "rewdp" / "weather" / "weather_dataset" / f"{city.capitalize()}.csv"
    w = pd.read_csv(p)
    w["datetime"] = pd.to_datetime(w["datetime"], format="mixed", errors="coerce")
    w = w.dropna(subset=["datetime"]).set_index("datetime").sort_index()
    w.columns = [c.lower().replace(" ", "_") for c in w.columns]
    # The station's hourly values are stamped interval-ENDING (clear-sky profiles are
    # symmetric around 12:30 rather than solar noon), while the household meters and NASA
    # POWER are hour-beginning. Shift by -1 h so all series share the hour-beginning convention.
    w.index = w.index - pd.Timedelta(hours=1)
    return w.apply(pd.to_numeric, errors="coerce")


def load_nasa_city(city: str) -> pd.DataFrame:
    """NASA POWER hourly for a Pakistani city on the PKT (UTC+5) clock. NASA "LST" is UTC plus
    the whole-hour 15-degree band offset, so Karachi (67.0E, band UTC+4) is shifted +1 h and the
    other cities (band UTC+5) are left unshifted."""
    from .config import CITIES
    p = DATA_DIR / "weather" / f"nasa_power_hourly_{city}_2023_2024.csv"
    wx = load_nasa_power(p)
    return lst_to_clock(wx, CITIES[city][1], 5.0)


def load_nepra_typical_days() -> pd.DataFrame:
    df = pd.read_csv(DATA_DIR / "pk" / "derived" / "nepra_hourly_typical_days.csv")
    df["hour"] = df["hour"].replace(0, 24)  # NEPRA prints the 24th hour as "0" in some years
    return df.sort_values(["year", "profile", "hour"]).reset_index(drop=True)


def load_nepra_monthly_peak() -> pd.DataFrame:
    return pd.read_csv(DATA_DIR / "pk" / "derived" / "nepra_monthly_system_peak_mw.csv")


def load_ember_pakistan_monthly() -> pd.DataFrame:
    em = pd.read_csv(DATA_DIR / "ember" / "ember_monthly.csv")
    em = em[(em["Area"] == "Pakistan")]
    return em


AEMO_REGIONS = {  # region: (city, lat, lon)
    "NSW1": ("sydney", -33.87, 151.21), "QLD1": ("brisbane", -27.47, 153.03),
    "VIC1": ("melbourne", -37.81, 144.96), "SA1": ("adelaide", -34.93, 138.60),
}


def lst_to_clock(wx: pd.DataFrame, lon: float, utc_offset: float) -> pd.DataFrame:
    """NASA POWER hourly "LST" stamps are UTC plus a WHOLE-hour offset taken from the 15-degree
    longitude band (round(lon/15)), not UTC + lon/15. Verified against time-standard=UTC
    downloads: Melbourne (145.0E) LST == UTC+10 and Adelaide (138.6E) LST == UTC+9 exactly.
    Convert to a fixed-offset clock (AEST = UTC+10, PKT = UTC+5) by a whole-hour shift, so no
    interpolation is needed: Sydney/Brisbane/Melbourne 0 h, Adelaide +1 h, Karachi +1 h.
    Always returns a new frame, so callers may modify the result without touching `wx`."""
    shift = utc_offset - round(lon / 15.0)
    out = wx.copy()
    if shift:
        out.index = out.index + pd.Timedelta(hours=shift)
    return out


def load_aemo_region(region: str) -> pd.DataFrame:
    """Hourly operational (net) demand, AEMO's rooftop-PV estimate (ROOFTOP_PV_ACTUAL type
    MEASUREMENT) and NASA POWER weather for one NEM region, AEST clock, tz-naive. Requires
    aemo_rooftop_all_regions_2024_hourly.csv."""
    city, lat, lon = AEMO_REGIONS[region]
    files = _aemo_demand_files(region)
    d = pd.concat((pd.read_csv(f) for f in files), sort=True)
    d["t"] = pd.to_datetime(d["SETTLEMENTDATE"])
    dem = aemo_halfhour_to_hourly(d.set_index("t")["TOTALDEMAND"])
    allpv = pd.read_csv(DATA_DIR / "intl" / "aemo_rooftop_all_regions_2024_hourly.csv", index_col=0, parse_dates=True)
    pv = allpv[region]
    wxp = DATA_DIR / "weather" / f"nasa_power_hourly_{city}_2024.csv"
    wx = lst_to_clock(load_nasa_power(wxp), lon, 10.0)
    df = pd.concat([dem.rename("net_load_mw"), pv.rename("pv_mw")], axis=1, sort=True).join(wx, how="inner")
    df["underlying_mw"] = df["net_load_mw"] + df["pv_mw"]
    return df.dropna(subset=["net_load_mw", "pv_mw", "ghi", "t2m"])

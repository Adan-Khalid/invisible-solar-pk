"""Time conventions of the loaders, on tiny synthetic files that mimic the raw downloads.

AEMO stamps are interval-ENDING on AEST; NASA POWER hourly "LST" is UTC + round(lon/15) whole
hours, hour-beginning. Everything is moved onto hour-beginning stamps of a fixed-offset clock
(AEST = UTC+10, PKT = UTC+5) by whole-hour shifts only, never by interpolation.
"""
import numpy as np
import pandas as pd
import pytest

from invisible_solar import data as D
from invisible_solar.config import CITIES

NASA_COLS = "YEAR,MO,DY,HR,T2M,RH2M,WS10M,ALLSKY_SFC_SW_DWN,CLRSKY_SFC_SW_DWN"


def write_nasa(path, start, hours, ghi=None, lat=0.0, lon=0.0, missing_at=()):
    """A NASA POWER hourly CSV with its free-text header block. GHI defaults to 10 x hour index."""
    idx = pd.date_range(start, periods=hours, freq="1h")
    ghi = np.arange(hours, dtype=float) * 10 if ghi is None else np.asarray(ghi, float)
    lines = ["-BEGIN HEADER-", "NASA/POWER Source Native Resolution Hourly Data",
             f"Location: Latitude  {lat}   Longitude {lon}",
             "The value for missing source data that cannot be computed or is outside of the sources availability range: -999",
             "-END HEADER-", NASA_COLS]
    for i, t in enumerate(idx):
        g, gc = (-999.0, -999.0) if i in missing_at else (ghi[i], ghi[i] + 1)
        lines.append(f"{t.year},{t.month},{t.day},{t.hour},{20 + i % 5:.2f},50.00,3.00,{g:.1f},{gc:.1f}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")
    return idx


def write_aemo_demand(path, region, start, days):
    """5-min PRICE_AND_DEMAND file, interval-ending stamps; TOTALDEMAND = 1000 + minute count."""
    t = pd.date_range(pd.Timestamp(start) + pd.Timedelta(minutes=5), periods=days * 288, freq="5min")
    df = pd.DataFrame({"REGION": region, "SETTLEMENTDATE": t.strftime("%Y/%m/%d %H:%M:%S"),
                       "TOTALDEMAND": 1000 + np.arange(len(t)) * 5.0, "RRP": 50.0, "PERIODTYPE": "TRADE"})
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
    return df


# ---------------------------------------------------------------- lst_to_clock
@pytest.mark.parametrize("name, lon, utc_offset, shift_h", [
    ("Sydney", 151.21, 10, 0),
    ("Brisbane", 153.03, 10, 0),
    ("Melbourne", 144.96, 10, 0),
    ("Adelaide", 138.60, 10, 1),
    ("Karachi", 67.01, 5, 1),
    ("Lahore", 74.35, 5, 0),
])
def test_lst_to_clock_whole_hour_shift(name, lon, utc_offset, shift_h):
    idx = pd.date_range("2024-01-01", periods=48, freq="1h")
    wx = pd.DataFrame({"ghi": np.arange(48, dtype=float), "t2m": np.linspace(10, 30, 48)}, index=idx)
    out = D.lst_to_clock(wx, lon, utc_offset)
    assert out.index.equals(idx + pd.Timedelta(hours=shift_h))
    np.testing.assert_array_equal(out.values, wx.values)  # values untouched: no interpolation
    assert (out.index.minute == 0).all()
    assert wx.index.equals(idx)  # input not mutated
    out["ghi"] = -1.0  # the result is a new frame even when no shift is needed
    assert (wx["ghi"] >= 0).all()


def test_project_coordinates_match_the_shift_table():
    assert D.AEMO_REGIONS["NSW1"][2] == 151.21 and D.AEMO_REGIONS["VIC1"][2] == 144.96
    assert D.AEMO_REGIONS["SA1"][2] == 138.60 and D.AEMO_REGIONS["QLD1"][2] == 153.03
    assert CITIES["karachi"][1] == 67.01


# ---------------------------------------------------------------- AEMO half-hours
def test_aemo_halfhour_to_hourly_interval_ending_to_hour_beginning():
    stamps = pd.date_range("2024-01-01 00:30", "2024-01-02 00:00", freq="30min")  # interval-ending
    s = pd.Series(np.arange(len(stamps), dtype=float), index=stamps)
    h = D.aemo_halfhour_to_hourly(s)
    assert h.index[0] == pd.Timestamp("2024-01-01 00:00")
    assert h.index[-1] == pd.Timestamp("2024-01-01 23:00")
    assert len(h) == 24
    assert h.loc["2024-01-01 10:00"] == pytest.approx((s.loc["2024-01-01 10:30"] + s.loc["2024-01-01 11:00"]) / 2)
    pd.testing.assert_series_equal(D.aemo_halfhour_to_hourly(s.iloc[::-1]), h)  # order-independent


def test_aemo_halfhour_rule_also_handles_5min_demand():
    stamps = pd.date_range("2024-01-01 00:05", periods=24, freq="5min")  # 00:05 .. 02:00
    s = pd.Series(np.arange(24, dtype=float), index=stamps)
    h = D.aemo_halfhour_to_hourly(s)
    assert h.tolist() == [np.mean(range(12)), np.mean(range(12, 24))]
    assert h.index.tolist() == [pd.Timestamp("2024-01-01 00:00"), pd.Timestamp("2024-01-01 01:00")]


# ---------------------------------------------------------------- NASA POWER parser
def test_load_nasa_power_parses_header_and_missing(tmp_path):
    p = tmp_path / "nasa.csv"
    idx = write_nasa(p, "2024-03-01", 6, missing_at=(2,))
    wx = D.load_nasa_power(p)
    assert list(wx.columns) == ["t2m", "rh2m", "ghi", "ghi_clear"]
    assert wx.index.equals(pd.DatetimeIndex(idx))
    assert np.isnan(wx["ghi"].iloc[2]) and np.isnan(wx["ghi_clear"].iloc[2])  # -999 -> NaN
    assert wx["ghi"].iloc[3] == 30.0 and wx["ghi_clear"].iloc[3] == 31.0
    assert wx["t2m"].iloc[1] == 21.0


def test_load_nasa_power_without_optional_columns(tmp_path):
    p = tmp_path / "nasa_min.csv"
    p.write_text("-BEGIN HEADER-\n-END HEADER-\nYEAR,MO,DY,HR,T2M,ALLSKY_SFC_SW_DWN\n2024,1,1,0,15.0,0.0\n2024,1,1,1,14.0,-999\n")
    wx = D.load_nasa_power(p)
    assert wx["rh2m"].isna().all() and wx["ghi_clear"].isna().all()
    assert np.isnan(wx["ghi"].iloc[1])


def test_load_nasa_power_reads_utf8_whatever_the_locale(tmp_path):
    # UTF-8 "Ł" is C5 81; 0x81 is undefined in cp1252, so a locale-encoded read fails on Windows
    p = tmp_path / "nasa_utf8.csv"
    p.write_text("-BEGIN HEADER-\nSite: Łódź, 25 °C\n-END HEADER-\nYEAR,MO,DY,HR,T2M,ALLSKY_SFC_SW_DWN\n"
                 "2024,1,1,0,15.0,0.0\n", encoding="utf-8")
    wx = D.load_nasa_power(p)
    assert len(wx) == 1 and wx["t2m"].iloc[0] == 15.0


def test_load_nasa_power_without_data_header_names_the_file(tmp_path):
    p = tmp_path / "nasa_power_hourly_sydney_2024.csv"  # what the API leaves behind when it errors
    p.write_text('{"messages": ["The POWER API is temporarily unavailable"], "header": {}}\n', encoding="utf-8")
    with pytest.raises(ValueError, match="nasa_power_hourly_sydney_2024.csv: no NASA POWER data header"):
        D.load_nasa_power(p)


# ---------------------------------------------------------------- loaders on a fake DATA_DIR
@pytest.fixture
def fake_data(tmp_path, monkeypatch):
    monkeypatch.setattr(D, "DATA_DIR", tmp_path)
    return tmp_path


@pytest.mark.parametrize("load, region", [(lambda: D.load_aemo_region("SA1"), "SA1"),
                                          (D.load_aemo_nsw_2024, "NSW1")])
def test_aemo_loaders_name_the_folder_when_demand_files_are_missing(fake_data, load, region):
    with pytest.raises(FileNotFoundError) as exc:
        load()
    msg = str(exc.value)
    assert f"aemo_PRICE_AND_DEMAND_2024*_{region}.csv" in msg and str(fake_data / "intl") in msg
    assert "INVISIBLE_SOLAR_DATA" in msg


def test_load_aemo_region_aligns_demand_pv_and_weather(fake_data):
    dem = write_aemo_demand(fake_data / "intl" / "aemo_PRICE_AND_DEMAND_202401_SA1.csv", "SA1", "2024-01-01", 2)
    hours = pd.date_range("2024-01-01", periods=48, freq="1h", name="interval")
    pv = pd.DataFrame({r: np.arange(48, dtype=float) + k for k, r in enumerate(["NSW1", "QLD1", "VIC1", "SA1"])}, index=hours)
    pv.to_csv(fake_data / "intl" / "aemo_rooftop_all_regions_2024_hourly.csv")
    write_nasa(fake_data / "weather" / "nasa_power_hourly_adelaide_2024.csv", "2024-01-01", 48, lon=138.6)

    df = D.load_aemo_region("SA1")
    # NASA LST for Adelaide is UTC+9: its 00:00 stamp is 01:00 AEST, so the first joined hour is 01:00
    assert df.index[0] == pd.Timestamp("2024-01-01 01:00") and df.index[-1] == pd.Timestamp("2024-01-02 23:00")
    t = pd.Timestamp("2024-01-01 10:00")
    assert df.loc[t, "ghi"] == 90.0  # NASA stamp 09:00 LST (value 10 x 9)
    five_min = dem.set_index(pd.to_datetime(dem["SETTLEMENTDATE"]))["TOTALDEMAND"]
    assert df.loc[t, "net_load_mw"] == pytest.approx(five_min.loc["2024-01-01 10:05":"2024-01-01 11:00"].mean())
    assert df.loc[t, "pv_mw"] == 10 + 3
    np.testing.assert_allclose(df["underlying_mw"], df["net_load_mw"] + df["pv_mw"])


def test_load_aemo_nsw_2024_no_weather_shift(fake_data):
    write_aemo_demand(fake_data / "intl" / "aemo_PRICE_AND_DEMAND_202401_NSW1.csv", "NSW1", "2024-01-01", 1)
    hours = pd.date_range("2024-01-01", periods=24, freq="1h", name="interval")
    pd.Series(np.full(24, 7.0), index=hours).to_csv(fake_data / "intl" / "aemo_rooftop_nsw1_2024_hourly.csv", header=["rooftop_pv_mw"])
    write_nasa(fake_data / "weather" / "nasa_power_hourly_sydney_2024.csv", "2024-01-01", 24, lon=151.21)
    df = D.load_aemo_nsw_2024()
    assert len(df) == 24 and df.index[0] == pd.Timestamp("2024-01-01 00:00")
    assert df.loc["2024-01-01 12:00", "ghi"] == 120.0
    assert (df["pv_mw"] == 7.0).all()


def test_load_nasa_city_moves_karachi_onto_pkt(fake_data):
    write_nasa(fake_data / "weather" / "nasa_power_hourly_karachi_2023_2024.csv", "2023-06-01", 24, lon=67.0)
    write_nasa(fake_data / "weather" / "nasa_power_hourly_lahore_2023_2024.csv", "2023-06-01", 24, lon=74.4)
    k, lh = D.load_nasa_city("karachi"), D.load_nasa_city("lahore")
    assert k.index[0] == pd.Timestamp("2023-06-01 01:00") and k.loc["2023-06-01 12:00", "ghi"] == 110.0
    assert lh.index[0] == pd.Timestamp("2023-06-01 00:00") and lh.loc["2023-06-01 12:00", "ghi"] == 120.0


def test_rewdp_and_reference_tables(fake_data):
    w = fake_data / "pk" / "rewdp" / "weather" / "weather_dataset"
    w.mkdir(parents=True)
    (w / "Lahore.csv").write_text("datetime,Temperature,Solar Radiation\n2023-06-01 01:00,30.5,0\n"
                                  "2023-06-01 02:00,30.0,5\nnot a date,1,1\n")
    ws = D.load_rewdp_weather("lahore")
    assert list(ws.columns) == ["temperature", "solar_radiation"]
    assert ws.index[0] == pd.Timestamp("2023-06-01 00:00")  # interval-ending station stamps -> hour-beginning
    assert len(ws) == 2

    der = fake_data / "pk" / "derived"
    der.mkdir(parents=True)
    pd.DataFrame({"datetime": ["2023-06-01 00:00"], "kw": [1.5], "city": ["Lahore"], "house": ["1"]}).to_csv(der / "rewdp_hourly_all.csv", index=False)
    assert D.load_rewdp_hourly()["datetime"].iloc[0] == pd.Timestamp("2023-06-01")

    pd.DataFrame({"year": [2023, 2023, 2023], "profile": ["summer"] * 3, "hour": [0, 2, 1], "mw": [3.0, 2.0, 1.0]}).to_csv(
        der / "nepra_hourly_typical_days.csv", index=False)
    nt = D.load_nepra_typical_days()
    assert nt["hour"].tolist() == [1, 2, 24] and nt["mw"].tolist() == [1.0, 2.0, 3.0]

    pd.DataFrame({"year": [2023], "month": [6], "peak_mw": [29000]}).to_csv(der / "nepra_monthly_system_peak_mw.csv", index=False)
    assert D.load_nepra_monthly_peak()["peak_mw"].iloc[0] == 29000

    (fake_data / "ember").mkdir()
    pd.DataFrame({"Area": ["Pakistan", "India"], "Value": [1, 2]}).to_csv(fake_data / "ember" / "ember_monthly.csv", index=False)
    assert D.load_ember_pakistan_monthly()["Area"].tolist() == ["Pakistan"]

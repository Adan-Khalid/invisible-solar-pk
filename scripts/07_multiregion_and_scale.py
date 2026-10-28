"""Generalisation and scale. (a) Four NEM regions with AEMO's rooftop-PV series (NSW, QLD, VIC,
SA; ROOFTOP_PV_ACTUAL type MEASUREMENT, a measurement-based estimate); (b) a scale curve on Pakistani virtual feeders: recovery vs number of homes. Part (b) needs
the REWD-P data and is skipped (keeping the committed table) when it is absent. The figure is
drawn from the two tables by scripts/plot_scale_and_regions.py."""
import json, os, sys
from pathlib import Path

# Each fit is a small least-squares problem: multi-threaded BLAS only adds contention (4-10x slower
# on a busy machine). Set before numpy loads; export the variables yourself to override.
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

sys.path.insert(0, "src")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np, pandas as pd
from invisible_solar.data import load_aemo_region, load_rewdp_hourly, load_nasa_city, load_rewdp_weather
from invisible_solar import hidden_pv as H
from invisible_solar.config import DATA_DIR, TAB_DIR
from plot_scale_and_regions import PK_PROVENANCE, plot


def nem_regions() -> pd.DataFrame:
    rows = []
    for reg in ["NSW1", "QLD1", "VIC1", "SA1"]:
        df = load_aemo_region(reg)
        pv_share = df["pv_mw"].sum() / df["underlying_mw"].sum() * 100
        for mname, fn in [("IRR hourly", H.fit_irr), ("IRR daily-energy", H.fit_irr_daily)]:
            r = fn(df, country="AU"); ev = H.evaluate_pv(df["pv_mw"], r.pv_hat)
            tr, te = df[df.index.month % 2 == 1], df[df.index.month % 2 == 0]
            r2 = fn(tr, country="AU"); ev2 = H.evaluate_pv(te["pv_mw"], H.predict_irr(r2, te))
            rows.append(dict(region=reg, method=mname, mean_net_load_mw=round(df["net_load_mw"].mean()), peak_pv_mw=round(df["pv_mw"].max()),
                             rooftop_pv_share_of_underlying_pct=round(pv_share, 1),
                             recovery_full_pct=round(ev["energy_recovery_pct"], 1), corr_full=round(ev["corr_hourly"], 3), corr_daylight_full=round(ev["corr_daylight"], 3),
                             recovery_oddeven_pct=round(ev2["energy_recovery_pct"], 1), corr_oddeven=round(ev2["corr_hourly"], 3)))
        # naive baseline for the same region
        ni = df[(df.index.hour >= 22) | (df.index.hour <= 4)]
        night = ni["net_load_mw"].groupby(ni.index.month).mean()
        naive = pd.Series((night.reindex(df.index.month).values - df["net_load_mw"].values).clip(0), index=df.index).where(df["ghi"] > 0, 0)
        evn = H.evaluate_pv(df["pv_mw"], naive)
        rows.append(dict(region=reg, method="Naive midday-dip (no irradiance)", mean_net_load_mw=round(df["net_load_mw"].mean()), peak_pv_mw=round(df["pv_mw"].max()),
                         rooftop_pv_share_of_underlying_pct=round(pv_share, 1), recovery_full_pct=round(evn["energy_recovery_pct"], 1), corr_full=round(evn["corr_hourly"], 3), corr_daylight_full=round(evn["corr_daylight"], 3)))
    mr = pd.DataFrame(rows); mr.to_csv(TAB_DIR / "m1_multiregion_nem.csv", index=False)
    print(mr.to_string())
    return mr


def pv_model(ghi, t2m, kw_dc, pr=0.80, gamma=-0.004):
    tcell = t2m + 25 * ghi / 1000
    return np.clip(kw_dc * ghi / 1000 * pr * (1 + gamma * (tcell - 25)), 0, None)


def pk_scale_curve() -> pd.DataFrame:
    rng = np.random.default_rng(7)
    hh = load_rewdp_hourly(); hh = hh[hh["n_min"] >= 45]
    srows = []
    for city in ["Lahore", "Karachi", "Islamabad", "Multan", "Peshawar"]:
        c = hh[hh.city == city]
        piv = c.pivot_table(index="datetime", columns="house", values="kw").loc["2023-11-01":"2024-10-31"]
        homes = list(piv.columns)
        ws = load_rewdp_weather(city); nasa = load_nasa_city(city.lower())
        for n in [2, 4, 6, 8, 10]:
            if n > len(homes):
                continue
            for rep in range(8):
                sel = list(rng.choice(homes, size=n, replace=False))
                sub = piv[sel].dropna(thresh=max(1, int(n * 0.7))); feeder = sub.sum(axis=1)
                df = pd.DataFrame({"load_kw": feeder, "t2m": nasa["t2m"].reindex(feeder.index), "ghi": nasa["ghi"].reindex(feeder.index),
                                   "g_ground": ws["solar_radiation"].reindex(feeder.index), "t_ground": ws["temperature"].reindex(feeder.index)}).dropna()
                if len(df) < 4000:
                    continue
                k = max(1, int(round(0.4 * n))); kw_dc = float(rng.uniform(3, 7, size=k).sum())
                pv = pd.Series(pv_model(df["g_ground"].values, df["t_ground"].values, kw_dc), index=df.index)
                d = df.assign(net_load_mw=df["load_kw"] - pv)
                r = H.fit_irr(d, country="PK"); ev = H.evaluate_pv(pv, r.pv_hat)
                srows.append(dict(city=city, n_homes=n, rep=rep, mean_load_kw=float(feeder.mean()), recovery_pct=ev["energy_recovery_pct"], corr=ev["corr_hourly"]))
    sc = pd.DataFrame(srows); sc.to_csv(TAB_DIR / "m1_pk_scale_curve_raw.csv", index=False)
    agg = sc.groupby("n_homes").agg(recovery_mean=("recovery_pct", "mean"), recovery_sd=("recovery_pct", "std"), corr_mean=("corr", "mean"), mean_load_kw=("mean_load_kw", "mean")).reset_index()
    agg.to_csv(TAB_DIR / "m1_pk_scale_curve.csv", index=False); print(agg.round(2).to_string())
    # tells plot() that these tables use the whole-hour NASA POWER clock, so it drops the pre-fix note
    (TAB_DIR / PK_PROVENANCE).write_text(json.dumps({
        "tables": ["m1_pk_scale_curve.csv", "m1_pk_scale_curve_raw.csv"],
        "nasa_power_clock": "LST = UTC + round(lon/15) h, moved onto PKT by whole-hour shifts "
                            "(invisible_solar.data.lst_to_clock; Karachi +1 h, other cities 0 h)",
    }, indent=1) + "\n", encoding="utf-8")
    return agg


if __name__ == "__main__":
    nem_regions()
    if (DATA_DIR / "pk" / "derived" / "rewdp_hourly_all.csv").exists():
        pk_scale_curve()
    else:
        print(f"SKIP Pakistan scale curve: REWD-P not prepared (scripts/01_prepare_data.py); "
              f"plotting the existing {TAB_DIR / 'm1_pk_scale_curve.csv'}")
    print("saved", plot())

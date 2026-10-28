"""Module 3b: cooling-load flexibility in Pakistani homes (REWD-P sub-metered AC circuits).
Quantifies (i) AC share of household load by city in summer, (ii) AC share of the
17:00-22:00 evening-peak window, (iii) temperature sensitivity of load (kW per degC above
24 C, from the whole-house meter + NASA POWER temperature), and (iv) the evening cooling
energy that pre-cooling into solar hours could in principle shift."""
import os, sys

# The regressions are small least-squares problems: multi-threaded BLAS only adds contention.
# Set before numpy loads; export the variables yourself to override.
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

sys.path.insert(0, "src")
import numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from invisible_solar.data import load_rewdp_hourly, load_nasa_city
from invisible_solar.flexibility import cooling_share, precool_shift
from invisible_solar.config import FIG_DIR, TAB_DIR

hh = load_rewdp_hourly(); hh = hh[hh["n_min"] >= 45]
hh["datetime"] = pd.to_datetime(hh["datetime"])
summer = hh[hh["datetime"].dt.month.isin([5, 6, 7, 8, 9])]
rows = []
for city, g in summer.groupby("city"):
    if city == "Skardu":
        continue
    withac = g[g["n_ac_cols"] > 0]
    n_ac_homes = withac["house"].nunique(); n_homes = g["house"].nunique()
    ac_share = withac["ac_kw"].sum() / withac["kw"].sum() * 100 if len(withac) else np.nan
    eve = withac[withac["datetime"].dt.hour.between(17, 21)]
    ac_share_eve = eve["ac_kw"].sum() / eve["kw"].sum() * 100 if len(eve) else np.nan
    # whole-feeder temperature sensitivity
    piv = g.pivot_table(index="datetime", columns="house", values="kw")
    piv = piv.dropna(thresh=int(piv.shape[1] * 0.7)); feeder = piv.sum(axis=1)
    wx = load_nasa_city(city.lower()).reindex(feeder.index)
    cs = cooling_share(feeder, wx["t2m"], base=24.0)
    ps = precool_shift(cs["cooling_series"], shift_hours=2, window=(17, 22))
    # hourly profile of AC vs total (mean over summer) for homes with AC sub-metering
    prof = withac.groupby(withac["datetime"].dt.hour)[["kw", "ac_kw"]].mean()
    rows.append({"city": city, "homes": n_homes, "homes_with_AC_submeter": n_ac_homes, "AC_share_of_load_%": ac_share,
                 "AC_share_17-22h_%": ac_share_eve, "feeder_kW_per_degC_above_24C": cs["kw_per_degC"],
                 "temp_sensitive_share_%": cs["cooling_share_pct"], "evening_cooling_kWh_per_day_feeder": ps["shiftable_kwh_per_day"],
                 "feeder_mean_kW": float(feeder.mean()), "feeder_peak_kW": float(feeder.max()),
                 "AC_profile_peak_hour": int(prof["ac_kw"].idxmax())})
    fig, ax = plt.subplots(figsize=(7, 3.5))
    ax.plot(prof.index, prof["kw"], "k", label="Household total (mean, summer)")
    ax.plot(prof.index, prof["ac_kw"], "tab:red", label="Sub-metered AC circuits")
    ax.set_xlabel("hour"); ax.set_ylabel("kW per home"); ax.set_title(f"{city}: average summer day, homes with AC sub-metering (n={n_ac_homes})"); ax.legend(fontsize=8)
    fig.tight_layout(); fig.savefig(FIG_DIR / f"m3_cooling_profile_{city.lower()}.png", dpi=150); plt.close(fig)
tab = pd.DataFrame(rows); tab.to_csv(TAB_DIR / "m3_cooling_flexibility_by_city.csv", index=False)
print(tab.round(2).to_string())

"""Module 1 on Pakistan: a virtual residential feeder built from REWD-P (LUMS Energy
Institute) households. Because no Pakistani feeder publishes both net load and
metered rooftop PV, we inject rooftop PV of KNOWN size on a share of homes
(physics-based PV model driven by NASA POWER satellite irradiance + temperature),
hide it, and test whether the estimator recovers the injected capacity and energy.
We also test the two Lahore homes whose meters log real 'Generation (kW)'."""
import os, sys

# The IRR fits are small least-squares problems: multi-threaded BLAS only adds contention (4-10x
# slower on a busy machine). Set before numpy loads; export the variables yourself to override.
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

sys.path.insert(0, "src")
import numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from invisible_solar.data import load_rewdp_hourly, load_nasa_city, load_rewdp_weather
from invisible_solar import hidden_pv as H
from invisible_solar.config import FIG_DIR, TAB_DIR

rng = np.random.default_rng(42)
hh = load_rewdp_hourly()
hh = hh[hh["n_min"] >= 45]  # keep hours with >= 45 of 60 minutes logged
rows, capfit = [], []


def pv_model(ghi, t2m, kw_dc, pr=0.80, gamma=-0.004):
    """Simple rooftop PV: P = kW_dc * GHI/1000 * PR * (1 + gamma*(Tcell-25)), Tcell ≈ T2M + 25*GHI/1000 (NOCT-style)."""
    tcell = t2m + 25 * ghi / 1000
    return np.clip(kw_dc * ghi / 1000 * pr * (1 + gamma * (tcell - 25)), 0, None)


for city in ["Lahore", "Karachi", "Islamabad", "Multan", "Peshawar"]:
    c = hh[hh.city == city]
    piv = c.pivot_table(index="datetime", columns="house", values="kw")
    piv = piv.loc["2023-11-01":"2024-10-31"]
    piv = piv.dropna(thresh=int(piv.shape[1] * 0.7))  # need most homes present
    feeder = piv.sum(axis=1)  # kW
    n_homes = piv.shape[1]
    wx = load_nasa_city(city.lower()).reindex(feeder.index)
    df = pd.DataFrame({"load_kw": feeder, "t2m": wx["t2m"], "ghi": wx["ghi"]}).dropna()
    # Injection irradiance: prefer the REWD-P GROUND weather station (different source from the
    # satellite proxy used by the estimator) so the test includes realistic proxy mismatch.
    ws = load_rewdp_weather(city).reindex(df.index)
    ok = ws["solar_radiation"].notna() & ws["temperature"].notna()
    df = df[ok]; ws = ws[ok]
    sources = {"ground station (REWD-P), independent of estimator": (ws["solar_radiation"].values, ws["temperature"].values),
               "NASA POWER (same proxy as estimator; upper bound)": (df["ghi"].values, df["t2m"].values)}
    for inj_src, (inj_ghi, inj_t) in sources.items():
      rng = np.random.default_rng(42)
      for pen in [0.2, 0.4, 0.6]:
        # inject PV: each selected home gets 3-7 kW_dc (typical Pakistani net-metered rooftop)
        k = int(round(pen * n_homes))
        caps = rng.uniform(3, 7, size=k)
        kw_dc = float(caps.sum())
        pv = pd.Series(pv_model(inj_ghi, inj_t, kw_dc), index=df.index)
        d = df.copy(); d["net_load_mw"] = d["load_kw"] - pv  # units: kW, but column name reused
        true_eff = float(H.implied_capacity_from_truth(pv, d["ghi"]))
        for mname, fn in [("IRR hourly", H.fit_irr), ("IRR daily-energy", H.fit_irr_daily)]:
            irr = fn(d, load_col="net_load_mw", ghi_col="ghi", temp_col="t2m", country="PK")
            ev = H.evaluate_pv(pv, irr.pv_hat)
            est_cap = float(irr.capacity_mw_by_month.mean())
            ev.update(city=city, injection_irradiance=inj_src, method=mname, n_homes=n_homes, homes_with_pv=k, penetration_pct=pen * 100, injected_kw_dc=round(kw_dc, 1),
                      injected_effective_kw=round(true_eff, 1), estimated_effective_kw=round(est_cap, 1),
                      feeder_mean_kw=round(float(df["load_kw"].mean()), 1), daytime_net_min_kw=round(float(d["net_load_mw"].min()), 1))
            rows.append(ev)
        if pen == 0.4 and inj_src.startswith("ground"):
            irr = H.fit_irr_daily(d, load_col="net_load_mw", ghi_col="ghi", temp_col="t2m", country="PK")
            # figure for one city at 40% penetration
            wk = d.loc["2024-05-13":"2024-05-19"]
            fig, ax = plt.subplots(2, 1, figsize=(11, 5.5), sharex=True)
            ax[0].plot(wk.index, wk["load_kw"], color="tab:gray", ls="--", label="True underlying load (hidden from estimator)")
            ax[0].plot(wk.index, wk["net_load_mw"], color="k", label="Net load the DISCO sees")
            ax[0].set_ylabel("kW"); ax[0].legend(fontsize=8); ax[0].set_title(f"{city} virtual feeder ({n_homes} REWD-P homes), {k} homes with PV ({kw_dc:.0f} kW_dc) driven by GROUND irradiance; estimator sees only satellite GHI")
            ax[1].plot(wk.index, pv.loc[wk.index], color="tab:orange", label="Injected rooftop PV (truth)")
            ax[1].plot(wk.index, irr.pv_hat.loc[wk.index], color="tab:blue", label="Estimated from net load + NASA POWER GHI (IRR daily-energy)")
            ax[1].set_ylabel("kW"); ax[1].legend(fontsize=8)
            fig.tight_layout(); fig.savefig(FIG_DIR / f"m1_pk_{city.lower()}_feeder_week.png", dpi=150); plt.close(fig)

tab = pd.DataFrame(rows)[["city", "injection_irradiance", "method", "n_homes", "homes_with_pv", "penetration_pct", "injected_kw_dc", "injected_effective_kw", "estimated_effective_kw", "energy_recovery_pct", "r2_hourly", "corr_hourly", "feeder_mean_kw", "daytime_net_min_kw"]]
tab.to_csv(TAB_DIR / "m1_pk_virtual_feeder_recovery.csv", index=False)
print(tab.round(2).to_string())

# NOTE: REWD-P Lahore House8/House9 carry a "Generation (kW)" column, but after hourly
# aggregation it contains no non-zero values in this release, so no real-PV check is possible here.
print("saved")

"""Module 2: does knowing about hidden solar reduce day-ahead net-load forecast error?
Benchmark on (a) NSW real operational demand 2024 and (b) the Lahore/Karachi virtual
feeders with injected rooftop PV (40% of homes)."""
import os, sys

# The IRR fits are small least-squares problems: multi-threaded BLAS only adds contention (4-10x
# slower on a busy machine). Set before numpy loads; export the variables yourself to override.
# OMP_NUM_THREADS is left alone so the LightGBM forecasters keep their usual threading.
for _var in ("OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

sys.path.insert(0, "src")
import numpy as np, pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from invisible_solar.data import load_aemo_nsw_2024, load_rewdp_hourly, load_nasa_city
from invisible_solar import hidden_pv as H
from invisible_solar.forecast import run_benchmark
from invisible_solar.config import FIG_DIR, TAB_DIR

rng = np.random.default_rng(42)
out = []

# (a) NSW: estimate hidden PV with IRR on the training period only (no leakage), then forecast
nsw = load_aemo_nsw_2024()
split = "2024-10-01"
irr = H.fit_irr(nsw[nsw.index < split], country="AU")
nsw["pv_hat"] = H.predict_irr(irr, nsw)
tab, preds = run_benchmark(nsw, "net_load_mw", split, pv_col="pv_hat", country="AU")
tab.insert(0, "case", "NSW 2024 real net load (test Oct-Dec)"); out.append(tab)
wk = preds.loc["2024-11-11":"2024-11-17"]
fig, ax = plt.subplots(figsize=(11, 4))
ax.plot(wk.index, wk["actual"], "k", label="Actual net load")
ax.plot(wk.index, wk["LightGBM, no solar input"], color="tab:red", alpha=0.8, label="LightGBM, no solar input")
ax.plot(wk.index, wk["LightGBM + GHI + hidden-PV estimate"], color="tab:blue", alpha=0.9, label="LightGBM + GHI + hidden-PV estimate")
ax.fill_between(wk.index, wk["LightGBM + GHI + hidden-PV estimate q10"], wk["LightGBM + GHI + hidden-PV estimate q90"], color="tab:blue", alpha=0.15, label="80% interval")
ax.set_ylabel("MW"); ax.set_title("NSW day-ahead net-load forecast, one test week (Nov 2024)"); ax.legend(fontsize=8)
fig.tight_layout(); fig.savefig(FIG_DIR / "m2_nsw_forecast_week.png", dpi=150)

# (b) Pakistan virtual feeders. Without the REWD-P download, keep the previously published
# Pakistani rows unchanged so the NSW part can still be rerun on its own.
def pv_model(ghi, t2m, kw_dc, pr=0.80, gamma=-0.004):
    tcell = t2m + 25 * ghi / 1000
    return np.clip(kw_dc * ghi / 1000 * pr * (1 + gamma * (tcell - 25)), 0, None)
try:
    hh = load_rewdp_hourly(); hh = hh[hh["n_min"] >= 45]
    pk_cities = ["Lahore", "Karachi"]
except FileNotFoundError:
    pk_cities = []
    prev = TAB_DIR / "m2_forecast_benchmark.csv"
    if prev.exists():
        old = pd.read_csv(prev)
        out.append(old[~old["case"].str.startswith("NSW")])
    print("REWD-P hourly data not found: Pakistani rows kept from the previous table; NSW rows recomputed.")
for city in pk_cities:
    c = hh[hh.city == city]
    piv = c.pivot_table(index="datetime", columns="house", values="kw").loc["2023-11-01":"2024-10-31"]
    piv = piv.dropna(thresh=int(piv.shape[1] * 0.7))
    feeder = piv.sum(axis=1)
    wx = load_nasa_city(city.lower()).reindex(feeder.index)
    df = pd.DataFrame({"load_kw": feeder, "t2m": wx["t2m"], "ghi": wx["ghi"]}).dropna().asfreq("1h")
    k = int(round(0.4 * piv.shape[1])); kw_dc = float(rng.uniform(3, 7, size=k).sum())
    pv = pv_model(df["ghi"].values, df["t2m"].values, kw_dc)
    df["net_load_mw"] = df["load_kw"] - pv
    split_pk = "2024-08-01"
    irr = H.fit_irr(df.dropna()[df.dropna().index < split_pk], country="PK")
    df["pv_hat"] = H.predict_irr(irr, df.fillna({"ghi": 0}))
    tab, preds = run_benchmark(df, "net_load_mw", split_pk, pv_col="pv_hat", country="PK")
    tab.insert(0, "case", f"{city} virtual feeder, 40% homes with PV ({kw_dc:.0f} kW_dc) (test Aug-Oct 2024)"); out.append(tab)

res = pd.concat(out); res.to_csv(TAB_DIR / "m2_forecast_benchmark.csv", index=False)
print(res.round(2).to_string())

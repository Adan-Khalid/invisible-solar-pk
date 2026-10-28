"""Module 1 validation against AEMO's rooftop-PV series: NSW (Australia) 2024.
AEMO publishes operational demand (net of rooftop PV) AND its rooftop-PV estimate
(ROOFTOP_PV_ACTUAL, type MEASUREMENT: a measurement-based estimate, not a census).
We hide the PV series from the estimators and see how much of it they recover
using only net load + NASA POWER satellite irradiance.

    python scripts/02_hidden_pv_aemo.py                 # tables + the two NSW figures
    python scripts/02_hidden_pv_aemo.py --figures-only  # redraw the two figures; writes no table

--figures-only re-fits only the two full-year estimators the figures show (IRR and CFI) and leaves
results/tables/ untouched. A full rerun rewrites the tables, and the least-squares fits can differ
from the committed values in the last digits (around the 13th significant figure) between
machines and BLAS builds.
"""
import argparse, json, os, sys

# The IRR fits are small least-squares problems: multi-threaded BLAS only adds contention (4-10x
# slower on a busy machine). Set before numpy loads; export the variables yourself to override.
# OMP_NUM_THREADS is left alone so LightGBM (the CFI baseline) keeps its usual threading.
for _var in ("OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

sys.path.insert(0, "src")
import pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from invisible_solar.data import load_aemo_nsw_2024
from invisible_solar import hidden_pv as H
from invisible_solar.config import FIG_DIR, TAB_DIR

COUNTRY = "AU"
FULL, ODD_EVEN = "full-year fit", "fit odd months, test even months"
IRR, IRR_DAILY, CFI = "IRR (linear)", "IRR-daily (linear, daily energy)", "CFI (LightGBM)"
COLUMNS = ["method", "split", "energy_recovery_pct", "r2_hourly", "nrmse_daylight_pct", "corr_hourly",
           "corr_daylight", "r2_daylight", "peak_true_mw", "peak_hat_mw"]


def _row(truth, est, method, split) -> dict:
    return {**H.evaluate_pv(truth, est), "method": method, "split": split}


def naive_dip(df) -> pd.Series:
    """Naive "hour-of-day dip" baseline, i.e. what you get without an irradiance regression:
    PV = max(0, monthly mean night-time (22-04 h) net load - net load). GHI > 0 only marks
    daylight hours. Crude, shown for contrast."""
    night = df[(df.index.hour >= 22) | (df.index.hour <= 4)]["net_load_mw"].groupby([df[(df.index.hour >= 22) | (df.index.hour <= 4)].index.month]).mean()
    naive = (night.reindex(df.index.month).values - df["net_load_mw"].values).clip(0)
    return pd.Series(naive, index=df.index).where(df["ghi"] > 0, 0)


def recovery_table(df, irr, pv_cfi) -> pd.DataFrame:
    """The estimator comparison, rows in the published order: in-sample full year, then two
    held-out splits (Jan-Jun -> Jul-Dec, odd -> even months), then the naive baseline."""
    pv = df["pv_mw"]
    odd, even = df[df.index.month % 2 == 1], df[df.index.month % 2 == 0]
    h1, h2 = df[df.index.month <= 6], df[df.index.month > 6]
    rows = [_row(pv, irr.pv_hat, IRR, FULL),
            _row(pv, H.fit_irr_daily(df, country=COUNTRY).pv_hat, IRR_DAILY, FULL),  # robust to proxy noise
            _row(even["pv_mw"], H.predict_irr(H.fit_irr_daily(odd, country=COUNTRY), even), IRR_DAILY, ODD_EVEN),
            _row(pv, pv_cfi, CFI, FULL)]
    for train, test, split in [(h1, h2, "fit Jan-Jun, test Jul-Dec"), (odd, even, ODD_EVEN)]:
        rows.append(_row(test["pv_mw"], H.predict_irr(H.fit_irr(train, country=COUNTRY), test), IRR, split))
        model, feats = H.fit_cfi(train, country=COUNTRY)
        rows.append(_row(test["pv_mw"], H.predict_cfi(model, feats, test), CFI, split))
    rows.append(_row(pv, naive_dip(df), "Naive night-anchored dip (no irradiance)", "full-year"))
    return pd.DataFrame(rows)[COLUMNS]


def write_tables(df, irr, pv_cfi) -> None:
    tab = recovery_table(df, irr, pv_cfi)
    tab.to_csv(TAB_DIR / "m1_aemo_nsw_hidden_pv_recovery.csv", index=False)
    print(tab.round(3).to_string())
    cap = pd.DataFrame({"irr_capacity_mw": irr.capacity_mw_by_month,
                        "true_implied_capacity_mw": [H.implied_capacity_from_truth(df[df.index.month == m]["pv_mw"], df[df.index.month == m]["ghi"]) for m in range(1, 13)]})
    cap.index.name = "month"; cap.to_csv(TAB_DIR / "m1_aemo_nsw_capacity_by_month.csv")
    print(cap.round(0).to_string())
    with open(TAB_DIR / "m1_meta.json", "w") as f:
        json.dump({"n_hours": len(df)}, f)


def plot_two_weeks(df, irr, pv_cfi) -> None:
    fig, ax = plt.subplots(2, 1, figsize=(11, 6), sharex=True)
    wk = df.loc["2024-10-07":"2024-10-20"]
    ax[0].plot(wk.index, wk["net_load_mw"], label="Operational (net) demand", color="k")
    ax[0].plot(wk.index, wk["underlying_mw"], label="Underlying demand (net + AEMO rooftop-PV estimate)", color="tab:gray", ls="--")
    ax[0].set_ylabel("MW"); ax[0].legend(loc="upper right", fontsize=8)
    ax[0].set_title("NSW, two weeks in October 2024: what the operator sees vs underlying demand (net + AEMO rooftop-PV estimate)", fontsize=10.5)
    ax[1].plot(wk.index, wk["pv_mw"], label="AEMO rooftop PV (measurement-based estimate)", color="tab:orange")
    ax[1].plot(wk.index, irr.pv_hat.loc[wk.index], label="Estimated, IRR (net load + satellite GHI only)", color="tab:blue")
    ax[1].plot(wk.index, pv_cfi.loc[wk.index], label="Estimated, CFI LightGBM", color="tab:green", alpha=0.8)
    ax[1].set_ylabel("MW"); ax[1].legend(loc="upper right", fontsize=8)
    fig.tight_layout(); fig.savefig(FIG_DIR / "m1_aemo_nsw_two_weeks.png", dpi=150)
    plt.close(fig)


def plot_scatter_monthly(df, irr, pv_cfi) -> None:
    fig, ax = plt.subplots(1, 2, figsize=(10, 4))
    ax[0].scatter(df["pv_mw"], irr.pv_hat, s=2, alpha=0.3); ax[0].plot([0, 6000], [0, 6000], "r--"); ax[0].set_xlabel("AEMO rooftop-PV estimate (MW)"); ax[0].set_ylabel("IRR estimate (MW)"); ax[0].set_title("Hourly, 2024")
    mon = pd.DataFrame({"AEMO estimate": df["pv_mw"].resample("MS").sum() / 1000, "IRR": irr.pv_hat.resample("MS").sum() / 1000, "CFI": pv_cfi.resample("MS").sum() / 1000})
    mon.index = [d.strftime("%b") for d in mon.index]; mon.plot(kind="bar", ax=ax[1], rot=0); ax[1].set_ylabel("GWh / month"); ax[1].set_title("Monthly rooftop PV: AEMO estimate vs IRR / CFI")
    fig.tight_layout(); fig.savefig(FIG_DIR / "m1_aemo_nsw_scatter_monthly.png", dpi=150)
    plt.close(fig)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--figures-only", action="store_true",
                    help="redraw the two NSW figures from the full-year IRR and CFI fits; write no table")
    args = ap.parse_args(argv)
    df = load_aemo_nsw_2024()
    print("rows", len(df), df.index.min(), df.index.max())
    irr = H.fit_irr(df, country=COUNTRY)
    model, feats = H.fit_cfi(df, country=COUNTRY)
    pv_cfi = H.predict_cfi(model, feats, df)
    if not args.figures_only:
        write_tables(df, irr, pv_cfi)
    plot_two_weeks(df, irr, pv_cfi)
    plot_scatter_monthly(df, irr, pv_cfi)
    print("saved figures" + (" (tables untouched)" if args.figures_only else ""))


if __name__ == "__main__":
    main()

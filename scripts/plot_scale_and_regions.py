"""Figure m1_scale_and_regions.png, rebuilt only from result tables (no raw data needed):
results/tables/m1_multiregion_nem.csv (four NEM regions, AEMO's rooftop-PV estimate as truth),
results/tables/m1_pk_scale_curve.csv (Pakistani virtual feeders, recovery vs number of homes) and,
when present, m1_pk_scale_curve_raw.csv (every draw; gives the per-city lines in panel b).

    python scripts/plot_scale_and_regions.py

scripts/07_multiregion_and_scale.py calls plot() after writing the tables."""
import sys
from pathlib import Path

sys.path.insert(0, "src")
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from invisible_solar.config import FIG_DIR, TAB_DIR

# method -> (label, colour, marker); categorical slots 1-3 of the reference palette, shapes as
# secondary encoding so identity never rests on colour alone
METHODS = {
    "IRR hourly": ("IRR hourly (the anchored estimator)", "#2a78d6", "o"),
    "IRR daily-energy": ("IRR daily-energy variant", "#eb6834", "s"),
    "Naive midday-dip (no irradiance)": ("Naive midday dip (no irradiance)", "#1baf7a", "^"),
}
INK, MUTED, GRID, CITY_LINE, CAVEAT = "#0b0b0b", "#52514e", "#e4e3df", "#a3a19c", "#9a3412"
REGION_NAMES = {"NSW1": "NSW", "QLD1": "QLD", "VIC1": "VIC", "SA1": "SA"}

# scripts/07_multiregion_and_scale.py writes this file whenever it recomputes the Pakistani scale
# curve with the whole-hour NASA POWER clock (invisible_solar.data.lst_to_clock). Without it the
# committed tables predate the 24 Oct 2026 time-alignment fix, and panel (b) says so.
PK_PROVENANCE = "m1_pk_scale_curve_provenance.json"
PRE_FIX_NOTE = ("Pre-fix numbers: computed before the 24 Oct 2026 NASA POWER time-alignment fix,\n"
                "which affects Karachi only (+0.53 h interpolated → +1 h whole shift); rerun pending.")


def _ylim(values) -> float:
    """Upper limit that shows every point (including recoveries above 100 %) with headroom."""
    return float(np.ceil((np.nanmax(values) + 12) / 10) * 10)


def _style(ax):
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(MUTED)
    ax.tick_params(colors=MUTED, labelcolor=INK)


def _reference_line(ax, xmax, label: str):
    ax.axhline(100, color=MUTED, linestyle="--", linewidth=1.2, zorder=1)
    ax.text(xmax, 101.5, label, ha="right", va="bottom", fontsize=8, color=MUTED)


def _nem_panel(ax, mr: pd.DataFrame):
    """(a) regions on a categorical axis ordered by size, methods dodged so no marker hides another."""
    regions = (mr.drop_duplicates("region").sort_values("mean_net_load_mw")
               .set_index("region")["mean_net_load_mw"])
    x = np.arange(len(regions))
    for k, (method, (label, colour, marker)) in enumerate(METHODS.items()):
        m = mr[mr["method"] == method].set_index("region").reindex(regions.index)
        xs = x + (k - 1) * 0.22
        ax.scatter(xs, m["recovery_full_pct"], s=70, color=colour, marker=marker, label=label,
                   edgecolor="white", linewidth=1.5, zorder=3)
        if method == "IRR hourly":  # direct labels on the headline series only
            for xi, v in zip(xs, m["recovery_full_pct"]):
                ax.annotate(f"{v:.1f}%", (xi, v), textcoords="offset points", xytext=(0, 8),
                            ha="center", va="bottom", fontsize=8.5, color=INK)
    ax.set_xticks(x, [f"{REGION_NAMES.get(r, r)}\n{v:,.0f} MW" for r, v in regions.items()])
    ax.set_xlim(-0.6, len(regions) - 0.4)
    ax.set_xlabel("NEM region and its mean net load, 2024 (smallest to largest)", color=INK)
    ax.set_ylabel("Share of rooftop-PV energy recovered (%)", color=INK)
    ax.set_title("(a) Four Australian regions, AEMO rooftop-PV estimate as truth",
                 loc="left", fontsize=11, color=INK)
    _style(ax)
    _reference_line(ax, len(regions) - 0.45, "100% = all of AEMO's estimated PV energy")
    ax.legend(loc="upper right", fontsize=8.5, frameon=True, framealpha=0.95, edgecolor=GRID)
    ax.text(0.0, -0.22, "Full year, in-sample: fitted on net load + NASA POWER irradiance; the PV truth is "
            "never used in fitting.\nTruth = AEMO ROOFTOP_PV_ACTUAL (measurement-based estimate).",
            transform=ax.transAxes, fontsize=8, color=MUTED, va="top")


def _draws_text(raw: pd.DataFrame | None) -> str:
    """'5 cities x 8 random draws', counted from the per-draw table (draws can drop out on a rerun)."""
    if raw is None:
        return "random draws of homes"
    per_cell = raw.groupby(["n_homes", "city"]).size()
    draws = f"{per_cell.min()}" if per_cell.min() == per_cell.max() else f"{per_cell.min()}-{per_cell.max()}"
    return f"{raw['city'].nunique()} cities × {draws} random draws"


def _city_lines(ax, raw: pd.DataFrame, x_label: float):
    """Faint per-city means: they show that the pooled spread is mostly between cities."""
    city_means = raw.groupby(["city", "n_homes"])["recovery_pct"].mean().unstack("city").sort_index()
    for k, city in enumerate(city_means.columns):
        s = city_means[city].dropna()
        ax.plot(s.index, s.values, color=CITY_LINE, linewidth=1.1, marker="o", markersize=3, zorder=2,
                label="Mean of one city's draws" if k == 0 else None)
        ax.text(x_label, s.iloc[-1], city, ha="left", va="center", fontsize=8, color=MUTED)


def _pk_panel(ax, sc: pd.DataFrame, raw: pd.DataFrame | None, pre_fix: bool):
    """(b) Pakistani virtual feeders: pooled mean +/- 1 s.d., per-city means behind it."""
    n_max = sc["n_homes"].max()
    if raw is not None:
        _city_lines(ax, raw, n_max + 0.3)
    ax.errorbar(sc["n_homes"], sc["recovery_mean"], yerr=sc["recovery_sd"], color=METHODS["IRR hourly"][1],
                marker="o", markersize=8, markeredgecolor="white", markeredgewidth=1.5, linewidth=2,
                elinewidth=1.2, capsize=4, zorder=3,
                label=f"IRR hourly, all feeders: mean ± 1 s.d.\n({_draws_text(raw)})")
    for _, r in sc.iloc[[0, -1]].iterrows():  # end points only; the grid carries the rest
        ax.annotate(f"{r['recovery_mean']:.0f}%", (r["n_homes"], r["recovery_mean"]), textcoords="offset points",
                    xytext=(-8, -4), ha="right", va="top", fontsize=8.5, color=INK,
                    bbox=dict(boxstyle="round,pad=0.15", facecolor="white", edgecolor="none", alpha=0.85))
    ax.set_xticks(sc["n_homes"], [f"{int(n)}\n{kw:.1f} kW" for n, kw in zip(sc["n_homes"], sc["mean_load_kw"])])
    ax.set_xlim(sc["n_homes"].min() - 1, n_max + 2.4)
    ax.set_xlabel("Homes per virtual feeder, and their mean aggregate load", color=INK)
    ax.set_title("(b) Pakistani virtual feeders: recovery vs number of homes", loc="left", fontsize=11, color=INK)
    _style(ax)
    ax.tick_params(labelleft=True)
    _reference_line(ax, n_max + 2.3, "100% = all of the injected PV energy")
    # below the 100 % line: the band between it and the highest city line is empty
    ax.legend(loc="upper right", bbox_to_anchor=(1.0, 0.69), fontsize=8.5, frameon=True, framealpha=0.95,
              edgecolor=GRID)
    if pre_fix:
        ax.text(0.0, 0.995, PRE_FIX_NOTE, transform=ax.transAxes, fontsize=8, color=CAVEAT, va="top")
    ax.text(0.0, -0.22, "Virtual feeders, not metered ones: real REWD-P household load (LUMS) with\n"
            "rooftop PV of known size injected on ~40% of the homes; recovery is measured\n"
            "against that injected PV. The ± spread is mostly between cities (grey lines),\n"
            "not between draws of homes within a city.",
            transform=ax.transAxes, fontsize=8, color=MUTED, va="top")


def plot(tab_dir: Path = TAB_DIR, fig_dir: Path = FIG_DIR) -> Path:
    tab_dir = Path(tab_dir)
    mr = pd.read_csv(tab_dir / "m1_multiregion_nem.csv")
    sc = pd.read_csv(tab_dir / "m1_pk_scale_curve.csv").sort_values("n_homes")
    raw_path = tab_dir / "m1_pk_scale_curve_raw.csv"
    raw = pd.read_csv(raw_path) if raw_path.exists() else None
    pre_fix = not (tab_dir / PK_PROVENANCE).exists()
    top = _ylim(np.concatenate([mr["recovery_full_pct"].values,
                                (sc["recovery_mean"] + sc["recovery_sd"]).values]))

    fig, (ax0, ax1) = plt.subplots(1, 2, figsize=(12.5, 5.6), sharey=True,
                                   gridspec_kw=dict(width_ratios=[1.15, 1]))
    _nem_panel(ax0, mr)
    _pk_panel(ax1, sc, raw, pre_fix)
    ax0.set_ylim(0, top)
    fig.subplots_adjust(left=0.065, right=0.985, top=0.93, bottom=0.27, wspace=0.14)
    out = Path(fig_dir) / "m1_scale_and_regions.png"
    fig.savefig(out, dpi=150, facecolor="white")
    plt.close(fig)
    return out


if __name__ == "__main__":
    print("saved", plot())

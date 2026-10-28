"""Module 3a: shape of Pakistan's system demand on NEPRA's published typical days and the
battery needed to cap it, plus Ember's monthly solar share.

Input: NEPRA State of Industry reports 2020-2024 (table 'Hourly System Demand', calendar
years 2019-2023; National Power Control Centre data), converted and parsed by
scripts/parse_nepra_soi.py, which this script runs first (needs pdftotext). Metric
definitions are in invisible_solar.flexibility (hour labels 1..24 as printed by NEPRA).

Outputs: results/tables/m3_nepra_hourly_typical_days.csv, m3_nepra_ramp_atlas.csv,
m3_nepra_storage.csv, m3_ember_pk_*.csv; results/figures/m3_nepra_typical_days.png,
m3_ember_pakistan_monthly.png."""
import glob
import sys
from pathlib import Path
sys.path.insert(0, "src")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from parse_nepra_soi import build
from invisible_solar.config import DATA_DIR, FIG_DIR, TAB_DIR
from invisible_solar.data import load_nepra_typical_days, load_ember_pakistan_monthly
from invisible_solar.flexibility import profile_metrics, storage_to_shave, MIDDAY, EVENING, DUSK, RTE

CAPS = (0.95, 0.90)
SEASON = {"summer": range(5, 10), "winter": (12, 1, 2)}  # NEPRA SoI 2024 note: summer May-Sep, winter Dec-Feb
ORDER = ["summer_working", "summer_nonworking", "max_summer", "winter_working", "winter_nonworking", "max_winter"]

pk = DATA_DIR / "pk"
if glob.glob(str(pk / "nepra_soi_*.pdf")):
    build(str(pk))
elif not (pk / "derived" / "nepra_hourly_typical_days.csv").exists():
    sys.exit(f"no NEPRA PDFs or parsed CSV under {pk}; see data/README.md")

td = load_nepra_typical_days()
td[["year", "profile", "date", "hour", "demand_mw"]].to_csv(TAB_DIR / "m3_nepra_hourly_typical_days.csv", index=False)


def source_notes(y: int, p: str, g: pd.DataFrame) -> str:
    """Quirks of the printed source table: a date outside NEPRA's season months, or a typical-day
    column that repeats the day-of-maximum-demand column (or vice versa)."""
    season = "summer" if "summer" in p else "winter"
    notes = []
    if int(g["date"].iloc[0].split("-")[1]) not in SEASON[season]:
        notes.append(f"printed date is outside NEPRA's {season} months")
    twins = [f"max_{season}"] if not p.startswith("max_") else [f"{season}_working", f"{season}_nonworking"]
    for t in twins:
        other = td[(td.year == y) & (td.profile == t)]["demand_mw"].to_numpy()
        if len(other) == 24 and (other == g["demand_mw"].to_numpy()).all():
            what = "the day of maximum demand" if t.startswith("max_") else f"the typical {t.split('_')[1]} day"
            notes.append(f"same column as {what}")
    return "; ".join(notes)


rows, store = [], []
for (y, p), g in td.groupby(["year", "profile"]):
    s = g.set_index("hour")["demand_mw"]
    date = g["date"].iloc[0]
    rows.append(dict(profile=p, year=y, date=date, **profile_metrics(s), note=source_notes(y, p, g)))
    for c in CAPS:
        store.append(dict(profile=p, year=y, date=date, **storage_to_shave(s, c)))
o = lambda d: d.assign(_o=d.profile.map(ORDER.index))
atlas = o(pd.DataFrame(rows)).sort_values(["_o", "year"]).drop(columns="_o")
atlas.to_csv(TAB_DIR / "m3_nepra_ramp_atlas.csv", index=False, float_format="%.6g")
st = o(pd.DataFrame(store)).sort_values(["_o", "year", "cap_frac"], ascending=[True, True, False]).drop(columns="_o")
st.to_csv(TAB_DIR / "m3_nepra_storage.csv", index=False, float_format="%.6g")

# consistency checks between the storage columns (see flexibility.storage_to_shave)
bad = st[st.feasible != (st.cap_frac >= st.min_cap_frac - 1e-9)]
if len(bad):
    sys.exit(f"feasible disagrees with min_cap_frac (feasible caps not one interval):\n{bad}")
f = st[st.feasible]
if (f.min_storage_mwh > f.energy_mwh * (1 + 1e-9)).any() or st[~st.feasible].min_storage_mwh.notna().any():
    sys.exit("min_storage_mwh must be <= energy_mwh on feasible rows and NaN on infeasible rows")
if (st.min_cap_frac_free_charge > st.min_cap_frac + 1e-9).any():
    sys.exit("min_cap_frac_free_charge must not exceed min_cap_frac")

pd.set_option("display.width", 250)
print(atlas[["profile", "year", "day_max_mw", "day_max_hour", "midday_min_hour", "evening_peak_mw", "evening_peak_hour",
             "evening_ramp_mw", "evening_is_day_peak", "dusk_min_hour", "dusk_drop_mw", "night_peak_hour", "night_rise_mw",
             "steepest_3h_ramp_mw", "steepest_3h_start_hour", "note"]].to_string(index=False))
print(st[["profile", "year", "cap_frac", "power_mw", "energy_mwh", "min_storage_mwh", "hours_above_cap", "feasible",
          "min_cap_frac", "min_cap_frac_free_charge"]].round(4).to_string(index=False))

# figure: working-day profiles by year, summer and winter
years = sorted(td.year.unique())
colors = plt.cm.viridis([i / max(len(years) - 1, 1) * 0.9 for i in range(len(years))])
fig, axes = plt.subplots(1, 2, figsize=(12, 5.5), sharex=True)
for ax, prof, title in zip(axes, ("summer_working", "winter_working"), ("Typical summer working day", "Typical winter working day")):
    ax.axvspan(MIDDAY[0], MIDDAY[1], color="gold", alpha=0.15, label=f"midday window {MIDDAY[0]}-{MIDDAY[1]} h")
    ax.axvspan(EVENING[0], EVENING[1], color="tab:blue", alpha=0.08, label=f"evening window {EVENING[0]}-{EVENING[1]} h")
    for y, col in zip(years, colors):
        g = td[(td.profile == prof) & (td.year == y)]
        if g.empty:
            continue
        a = atlas[(atlas.profile == prof) & (atlas.year == y)].iloc[0]
        flag = ("*" if "outside" in a.note else "") + ("†" if "same column" in a.note else "")
        ax.plot(g["hour"], g["demand_mw"] / 1000, color=col, lw=1.8, label=f"{y} ({g['date'].iloc[0]}{flag})")
        ax.plot(a.day_max_hour, a.day_max_mw / 1000, "o", color=col, ms=5)
        if prof.startswith("summer"):  # the evening trough that summer days show at dusk
            ax.plot(a.dusk_min_hour, a.dusk_min_mw / 1000, "v", color=col, ms=6, mec="k", mew=0.5)
    ax.set_title(title); ax.set_xlabel("hour of day (NEPRA label 1-24)"); ax.set_xticks(range(1, 25, 2))
    ax.grid(alpha=0.3)
    if prof.startswith("summer"):
        ax.plot([], [], "v", color="0.6", mec="k", mew=0.5, label=f"evening trough (min over {DUSK[0]}-{DUSK[1]} h)")
    ax.legend(fontsize=7.5, loc="upper center", bbox_to_anchor=(0.5, -0.14), ncol=3, frameon=False)
axes[0].set_ylabel("system demand (GW)")
fig.suptitle(f"Pakistan system demand on NEPRA typical days, {years[0]}-{years[-1]} (dot = day maximum)", fontsize=11)
fig.text(0.01, 0.01, "Source: NEPRA State of Industry Reports 2020-2024, table 'Hourly System Demand' (NPCC). "
         "Typical days pre-date most of the 2024-25 rooftop solar build-out.\n* date as printed, outside NEPRA's season months. "
         "† NEPRA prints the same values as for the day of maximum winter demand.", fontsize=7, color="0.35")
fig.tight_layout(rect=(0, 0.035, 1, 1)); fig.savefig(FIG_DIR / "m3_nepra_typical_days.png", dpi=150); plt.close(fig)

# Ember monthly (methodology v1.6, Pakistan: NEPRA monthly generation plus Ember's own estimate of
# distributed solar, which NEPRA does not capture; Demand = generation + net imports)
em = load_ember_pakistan_monthly()
em = em.assign(Date=pd.to_datetime(em["Date"])).sort_values("Date")
pick = lambda var, unit: em[(em["Variable"] == var) & (em["Unit"] == unit)]
sol, dem = pick("Solar", "%"), pick("Demand", "TWh")
sol.to_csv(TAB_DIR / "m3_ember_pk_solar_share.csv", index=False); dem.to_csv(TAB_DIR / "m3_ember_pk_demand.csv", index=False)
twh = em[em["Unit"] == "TWh"].pivot_table(index="Date", columns="Variable", values="Value")
ann = twh[["Solar", "Total Generation", "Demand"]].groupby(twh.index.year).agg(["sum", "count"])
ann = pd.DataFrame({"year": ann.index, "months": ann[("Solar", "count")].values,
                    "solar_twh": ann[("Solar", "sum")].values, "generation_twh": ann[("Total Generation", "sum")].values,
                    "demand_twh": ann[("Demand", "sum")].values})
ann["solar_share_pct"] = 100 * ann.solar_twh / ann.generation_twh
ann.to_csv(TAB_DIR / "m3_ember_pk_annual.csv", index=False, float_format="%.6g")
print(ann.round(2).to_string(index=False))

fig, ax = plt.subplots(figsize=(9.5, 4.2))
l1, = ax.plot(sol["Date"], sol["Value"], color="tab:orange", lw=2, label="solar share of generation (%, left)")
ax.set_ylabel("solar share of generation (%)"); ax.grid(alpha=0.3)
ax2 = ax.twinx()
l2, = ax2.plot(dem["Date"], dem["Value"], color="k", alpha=0.6, lw=1.4, label="electricity demand (TWh/month, right)")
ax2.set_ylabel("demand (TWh/month)")
ax.legend(handles=[l1, l2], loc="upper left", fontsize=8.5)
first, last = sol["Date"].min().strftime("%b %Y"), sol["Date"].max().strftime("%b %Y")
ax.set_title(f"Pakistan, Ember monthly data {first} to {last}: solar includes Ember's estimate of distributed solar (e.g. rooftop)",
             fontsize=9.5)
fig.text(0.01, 0.01, "Source: Ember monthly electricity data (CC BY 4.0). Ember methodology v1.6: NEPRA monthly generation does not capture "
         "distributed solar, so Ember estimates it;\ndistributed fossil generation is not captured. Demand = generation + net imports, "
         "so it includes the solar estimate. Shares are of total generation including the estimate;\nthe distributed part is not "
         "published separately in this dataset.", fontsize=6.5, color="0.35")
fig.tight_layout(rect=(0, 0.08, 1, 1)); fig.savefig(FIG_DIR / "m3_ember_pakistan_monthly.png", dpi=150); plt.close(fig)
print("saved tables and figures; RTE =", RTE)

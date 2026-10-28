"""Build derived inputs from raw downloads: AEMO rooftop monthly zips -> hourly series (NSW1 and
all four regions); REWD-P 1-min household CSVs -> hourly (total, AC circuits). The two sections
are independent: each is skipped with a message when its raw input is missing. NEPRA PDF tables
-> CSV is a separate step (scripts/parse_nepra_soi.py).

Re-run this script if your aemo_rooftop_*_2024_hourly.csv files were written by commit 9d3f176 or
earlier: that version averaged the 10:00 and 10:30 interval-ending stamps into the 10:00 hour; the loaders now
expect hour-beginning hours (the 10:30 and 11:00 stamps) and cannot tell the two apart. A stale file
loads without error but is 30 min late; `python -m pytest -m rawdata` catches it (hash mismatch)."""
import sys, zipfile, glob, re
sys.path.insert(0, "src")
import numpy as np, pandas as pd
from invisible_solar.config import DATA_DIR
from invisible_solar.data import aemo_halfhour_to_hourly

AEMO_REGIONS = ["NSW1", "QLD1", "VIC1", "SA1"]


def prepare_aemo_rooftop() -> bool:
    """AEMO ROOFTOP_PV_ACTUAL (MEASUREMENT type), 30-min interval-ending -> hour-beginning hourly."""
    zips = sorted(glob.glob(str(DATA_DIR / "intl" / "aemo_rooftop_2024" / "rooftop_2024_*.zip")))
    if not zips:
        print(f"SKIP AEMO rooftop: no rooftop_2024_*.zip under {DATA_DIR / 'intl' / 'aemo_rooftop_2024'} (see data/README.md)")
        return False
    frames = []
    for zp in zips:
        z = zipfile.ZipFile(zp)
        for n in z.namelist():
            if not n.lower().endswith(".csv"):
                continue
            with z.open(n) as f:
                df = pd.read_csv(f, skiprows=1, header=None, engine="python", on_bad_lines="skip")
            df = df[df[0] == "D"].iloc[:, 4:9]; df.columns = ["interval", "region", "power_mw", "qi", "type"]; frames.append(df)
    a = pd.concat(frames); a["interval"] = pd.to_datetime(a["interval"]); a["power_mw"] = pd.to_numeric(a["power_mw"])
    hourly = {}
    for reg in AEMO_REGIONS:
        r = a[(a.region == reg) & (a.type == "MEASUREMENT")].drop_duplicates("interval").set_index("interval").sort_index()
        hourly[reg] = aemo_halfhour_to_hourly(r["power_mw"])
    hourly["NSW1"].to_csv(DATA_DIR / "intl" / "aemo_rooftop_nsw1_2024_hourly.csv", header=["rooftop_pv_mw"])
    pd.DataFrame(hourly).to_csv(DATA_DIR / "intl" / "aemo_rooftop_all_regions_2024_hourly.csv")
    print("AEMO rooftop hourly written (NSW1 + all regions)")
    return True


def prepare_rewdp() -> bool:
    """REWD-P (LUMS Energy Institute) 1-min household CSVs -> hourly kW per house."""
    zp = DATA_DIR / "pk" / "rewdp" / "rewdp_dataset.zip"
    if not zp.exists():
        print(f"SKIP REWD-P: {zp} not found (request access from LUMS, see data/README.md)")
        return False
    z = zipfile.ZipFile(zp)
    out = []
    for name in z.namelist():
        if not name.endswith(".csv"):
            continue
        parts = name.split("/"); city = parts[1]; fname = parts[2]
        if city == "Peshawar" and not fname.startswith("peshawar_"):
            continue  # duplicated files in the archive
        house = fname.replace(".csv", "").split("_")[-1]
        with z.open(name) as f:
            df = pd.read_csv(f)
        cols = list(df.columns); df = df.rename(columns={cols[0]: "datetime", cols[1]: "usage"})
        df["datetime"] = pd.to_datetime(df["datetime"], format="mixed", errors="coerce")
        df = df.dropna(subset=["datetime"]).set_index("datetime").sort_index().apply(pd.to_numeric, errors="coerce")
        ac_cols = [c for c in df.columns if c != "usage" and re.search(r"\bAC\b|_AC", c)]
        gen_cols = [c for c in df.columns if "generation" in c.lower()]
        df["ac"] = df[ac_cols].sum(axis=1) if ac_cols else np.nan
        df["gen"] = df[gen_cols].sum(axis=1) if gen_cols else np.nan
        h = pd.DataFrame({"kw": df["usage"].resample("1h").mean(), "n_min": df["usage"].resample("1h").count(),
                          "ac_kw": df["ac"].resample("1h").mean(), "gen_kw": df["gen"].resample("1h").mean()})
        h["city"] = city; h["house"] = house; h["n_ac_cols"] = len(ac_cols); out.append(h.reset_index())
        print(city, house, len(df))
    (DATA_DIR / "pk" / "derived").mkdir(parents=True, exist_ok=True)
    pd.concat(out).to_csv(DATA_DIR / "pk" / "derived" / "rewdp_hourly_all.csv", index=False)
    print("REWD-P hourly written.")
    return True


if __name__ == "__main__":
    done = [prepare_aemo_rooftop(), prepare_rewdp()]
    print("Now run scripts/parse_nepra_soi.py for the NEPRA tables.")
    if not any(done):
        sys.exit("No raw inputs found under INVISIBLE_SOLAR_DATA; nothing prepared.")

import os
from pathlib import Path

# Raw data directory. Override with INVISIBLE_SOLAR_DATA=/path (see data/README.md).
DATA_DIR = Path(os.environ.get("INVISIBLE_SOLAR_DATA", Path(__file__).resolve().parents[2] / "data"))
RESULTS_DIR = Path(os.environ.get("INVISIBLE_SOLAR_RESULTS", Path(__file__).resolve().parents[2] / "results"))
FIG_DIR = RESULTS_DIR / "figures"
TAB_DIR = RESULTS_DIR / "tables"
for d in (FIG_DIR, TAB_DIR):
    d.mkdir(parents=True, exist_ok=True)

# City coordinates used for NASA POWER (lat, lon)
CITIES = {
    "lahore": (31.52, 74.35), "karachi": (24.86, 67.01), "islamabad": (33.69, 73.04),
    "multan": (30.20, 71.47), "peshawar": (34.01, 71.58), "sydney": (-33.87, 151.21),
}

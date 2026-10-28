# Data (not committed)

Raw inputs are not in the repository. The scripts read them from `INVISIBLE_SOLAR_DATA`, which defaults to this `data/` folder (everything here except this README is git-ignored). Run every script from the repository root.

You do not need any of this to check the anchored estimates: the four AEMO evidence files in `chain/evidence/` are self-contained, and `python chain/verify_estimate.py` re-fits them.

## Download

`scripts/00_download_data.sh` fetches everything below into `$INVISIBLE_SOLAR_DATA` (default `./data`) and can be re-run. It is a bash script that needs `curl` and `unzip`.

- **Linux / macOS:** `bash scripts/00_download_data.sh`
- **Windows:** run the same command in **Git Bash**, which ships bash, curl, unzip and pdftotext. To use another folder, set the variable in both shells:
  - Git Bash, for the download: `export INVISIBLE_SOLAR_DATA=/d/invisible-solar-data`
  - PowerShell, for the Python scripts: `$env:INVISIBLE_SOLAR_DATA = "D:\invisible-solar-data"`

Ember's monthly CSV is about 70 MB, and the script's own note gives about 530 MB for REWD-P. On 24-25 Oct 2026 the LUMS download server did not respond and the dataset page listed below returned HTTP 404, so REWD-P may fail to download until LUMS restores them. The AEMO, NASA POWER, NEPRA and Ember parts do not depend on it.

## Raw files

| Path under `INVISIBLE_SOLAR_DATA` | Source | Terms |
|---|---|---|
| `intl/aemo_PRICE_AND_DEMAND_2024MM_<REGION>.csv` (MM = 01..12; REGION = NSW1, QLD1, VIC1, SA1) | AEMO NEM aggregated price and demand, 5-min operational demand (net of rooftop PV), https://aemo.com.au/energy-systems/electricity/national-electricity-market-nem/data-nem/aggregated-data | AEMO copyright; see AEMO's copyright permissions |
| `intl/aemo_rooftop_2024/rooftop_2024_MM.zip` | AEMO MMSDM monthly archives, table `ROOFTOP_PV_ACTUAL` (type `MEASUREMENT`, 30-min), https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/2024/ | AEMO copyright |
| `weather/nasa_power_hourly_<city>_2024.csv` (sydney, brisbane, melbourne, adelaide) and `weather/nasa_power_hourly_<city>_2023_2024.csv` (lahore, karachi, islamabad, multan, peshawar) | NASA POWER hourly API (T2M, RH2M, WS10M, ALLSKY_SFC_SW_DWN, CLRSKY_SFC_SW_DWN; CERES SYN1deg irradiance, MERRA-2 meteorology), https://power.larc.nasa.gov/ | Free; NASA asks users to reference the POWER project, https://power.larc.nasa.gov/docs/referencing/ |
| `pk/rewdp/rewdp_dataset.zip`, `pk/rewdp/weather/weather_dataset/<City>.csv` | REWD-P, Residential Energy and Weather Data Pakistan (LUMS Energy Institute): 1-min whole-home and appliance-circuit meters, plus city weather stations, https://lei.lums.edu.pk/datasets/residential-energy-and-weather-data-pakistan.html (could not be reached on 24-25 Oct 2026: the LUMS Energy Institute site returns HTTP 404 for this page) | Published as open data by the LUMS Energy Institute. The dataset page names no licence and asks for no specific citation, so credit the LUMS Energy Institute. |
| `pk/nepra_soi_<year>.pdf` (2020..2024) | NEPRA State of Industry Reports, table "Hourly System Demand (MW)", https://nepra.org.pk/publications/State%20of%20Industry%20Reports.php | Government publication |
| `ember/ember_monthly.csv` | Ember monthly electricity data (long format), https://ember-energy.org/data/monthly-electricity-data/ | CC BY 4.0 |

## Derived files (written by the scripts)

| Path | Written by | Notes |
|---|---|---|
| `intl/aemo_rooftop_nsw1_2024_hourly.csv`, `intl/aemo_rooftop_all_regions_2024_hourly.csv` | `scripts/01_prepare_data.py` | AEMO stamps are interval-ending (AEST, UTC+10). They are averaged into hour-beginning hours, so the 10:00 hour is the mean of the 10:30 and 11:00 values. **Re-run 01 if your copies were made with release 0.1.0:** those were half an hour late, and the loaders now read the files as already hour-beginning. |
| `pk/derived/rewdp_hourly_all.csv` | `scripts/01_prepare_data.py` | Hourly kW per house, total and AC circuits. The dataset page describes 60 households in six cities (Lahore, Multan, Peshawar, Karachi, Islamabad, Skardu). The analyses use the five cities in `src/invisible_solar/config.py`, 10 homes each (50 homes), over Nov 2023-Oct 2024. The archive's duplicated Peshawar files are skipped. |
| `pk/nepra_soi_<year>.txt`, `pk/derived/nepra_hourly_typical_days.csv` | `scripts/parse_nepra_soi.py` (also run by `scripts/05_nepra_ramp_atlas.py` when the PDFs are present) | See the NEPRA section below. |

## NEPRA tables need `pdftotext`

`parse_nepra_soi.py` converts each PDF with `pdftotext -layout` and parses the hourly-demand table.

**Installing `pdftotext`:**
- Linux: `sudo apt install poppler-utils`
- macOS: `brew install poppler`
- Windows: Git for Windows ships `pdftotext.exe` in `mingw64\bin`, and the parser finds it automatically. You can also run the script from Git Bash.

**What the reports contain:**
- The State of Industry report of year N carries calendar year N-1, so reports 2020-2024 give 2019-2023.
- Each year has six profiles: the summer and winter days of maximum demand, plus typical summer and winter working and non-working days.
- Hours are NEPRA's printed labels 1-24. The reports do not say whether they are hour-ending.

## Time alignment of NASA POWER

The hourly API's default "LST" stamps are UTC plus the whole-hour offset of the 15° longitude band, not UTC + longitude/15. The loaders in `src/invisible_solar/data.py` shift Adelaide (onto AEST, UTC+10) and Karachi (onto PKT, UTC+5) by +1 h and leave the other cities unchanged. The Pakistani result tables were computed before this rule was fixed on 24 Oct 2026, so Karachi is affected until REWD-P can be downloaded again and the tables re-run.

## Ember's Pakistan series

Ember's Pakistan "Solar" series includes Ember's own estimate of distributed (rooftop) solar. Ember's methodology (v1.6, Pakistan section) takes monthly generation from NEPRA and states that distributed solar is not captured there and is estimated by Ember. Ember's "Demand" includes that estimate too. The long-format file has no separate distributed-solar variable for Pakistan.

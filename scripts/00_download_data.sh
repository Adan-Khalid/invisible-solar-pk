#!/usr/bin/env bash
# Downloads every raw input into $INVISIBLE_SOLAR_DATA (default ./data). Re-runnable.
set -euo pipefail
D="${INVISIBLE_SOLAR_DATA:-$(cd "$(dirname "$0")/.." && pwd)/data}"
mkdir -p "$D/intl/aemo_rooftop_2024" "$D/weather" "$D/pk/rewdp" "$D/pk/derived" "$D/ember"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0"
echo "== AEMO NSW price & demand 2024 (5-min)"
for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
  curl -sS -L -A "$UA" -o "$D/intl/aemo_PRICE_AND_DEMAND_2024${m}_NSW1.csv" "https://aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_2024${m}_NSW1.csv"
done
for r in QLD1 VIC1 SA1; do for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
  curl -sS -L -A "$UA" -o "$D/intl/aemo_PRICE_AND_DEMAND_2024${m}_${r}.csv" "https://aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_2024${m}_${r}.csv"; done; done
echo "== AEMO rooftop PV actuals 2024 (MMSDM monthly archives)"
for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
  idx="https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/2024/MMSDM_2024_${m}/MMSDM_Historical_Data_SQLLoader/DATA/"
  href=$(curl -sS -A "$UA" "$idx" | grep -oiE 'href="[^"]*ROOFTOP_PV_ACTUAL[^"]*\.zip"' | head -1 | sed 's/href="//I;s/"$//')
  curl -sS -A "$UA" -o "$D/intl/aemo_rooftop_2024/rooftop_2024_${m}.zip" "https://nemweb.com.au${href}"
done
echo "== NASA POWER hourly (local solar time)"
nasa() { curl -sS -o "$D/weather/$1" "https://power.larc.nasa.gov/api/temporal/hourly/point?parameters=T2M,RH2M,WS10M,ALLSKY_SFC_SW_DWN,CLRSKY_SFC_SW_DWN&community=RE&longitude=$3&latitude=$2&start=$4&end=$5&format=CSV"; }
nasa nasa_power_hourly_sydney_2024.csv -33.87 151.21 20240101 20241231
nasa nasa_power_hourly_brisbane_2024.csv -27.47 153.03 20240101 20241231
nasa nasa_power_hourly_melbourne_2024.csv -37.81 144.96 20240101 20241231
nasa nasa_power_hourly_adelaide_2024.csv -34.93 138.60 20240101 20241231
nasa nasa_power_hourly_lahore_2023_2024.csv 31.52 74.35 20230701 20241231
nasa nasa_power_hourly_karachi_2023_2024.csv 24.86 67.01 20230701 20241231
nasa nasa_power_hourly_islamabad_2023_2024.csv 33.69 73.04 20230701 20241231
nasa nasa_power_hourly_multan_2023_2024.csv 30.20 71.47 20230701 20241231
nasa nasa_power_hourly_peshawar_2023_2024.csv 34.01 71.58 20230701 20241231
echo "== REWD-P (LUMS Energy Institute), ~530 MB"
curl -sS -A "$UA" -o "$D/pk/rewdp/rewdp_dataset.zip" "https://web.lums.edu.pk/~eig/gallery/datasets/rewdp/rewdp_dataset.zip"
curl -sS -A "$UA" -o "$D/pk/rewdp/weather_dataset.zip" "https://web.lums.edu.pk/~eig/gallery/datasets/rewdp/weather_dataset.zip"
(cd "$D/pk/rewdp" && unzip -oq weather_dataset.zip -d weather)
echo "== Ember monthly"
curl -sS -o "$D/ember/ember_monthly.csv" "https://storage.googleapis.com/emb-prod-bkt-publicdata/public-downloads/monthly_full_release_long_format.csv"
echo "== NEPRA State of Industry Reports (for the typical-day tables)"
for y in 2020 2021 2022 2023 2024; do
  curl -sS -A "$UA" -o "$D/pk/nepra_soi_${y}.pdf" "https://nepra.org.pk/publications/State%20of%20Industry%20Reports/State%20of%20Industry%20Report%20${y}.pdf"
done
echo "Now run: python scripts/01_prepare_data.py"

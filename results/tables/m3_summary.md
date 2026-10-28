# Module 3a: Pakistan typical-day demand shape and storage

**Source.** NEPRA State of Industry Reports 2020-2024, table "Hourly System Demand (MW)", printed with "Source: National Power Control Centre, Islamabad".
- The report of year N carries calendar year N-1, so the series covers 2019-2023.
- Each year has six profiles: the summer and winter days of maximum demand, and typical summer and winter working and non-working days.
- `scripts/parse_nepra_soi.py` parses the PDFs (pdftotext -layout). `scripts/05_nepra_ramp_atlas.py` runs the parser and writes `m3_nepra_hourly_typical_days.csv`, `m3_nepra_ramp_atlas.csv`, `m3_nepra_storage.csv` and the Ember tables `m3_ember_pk_*.csv`.

**Definitions** (`src/invisible_solar/flexibility.py`). Hours are NEPRA's printed labels 1-24, and every window is inclusive.
- **Evening ramp:** max over hours 17-24 minus min over hours 12-17.
- **Dusk trough:** min over hours 18-20.
- **Dusk drop:** max over hours 12-17 minus the dusk trough.
- **Night rise:** max over the hours after the trough, up to hour 24, minus the trough.
- **Steepest 3-h ramp:** max of s[h+3] - s[h].
- **Storage:** the cap is a fraction of the day maximum, and the battery repeats the same day.
  - *Power* (`power_mw`) is the largest hourly excess over the cap.
  - *Daily discharge* (`energy_mwh`) is the summed excess. It is an upper bound on storage size, not the size itself.
  - *Minimum storage* (`min_storage_mwh`) is the smallest usable capacity that holds the cap day after day, allowing recharging between separate above-cap blocks.
  - Charging is limited to the battery's power rating, and the round-trip efficiency of 0.9 is applied to charging.
  - A cap is *feasible* if the hours below it can refill the battery within the day.
  - The *lowest holdable cap* (`min_cap_frac`) is the lowest cap from which every higher cap is feasible.
  - `min_cap_frac_free_charge` is the same with unlimited charging power.

## Statements (these replace the old README and paper claims)

1. **Typical summer working days peak in mid-afternoon.**
   - The day maximum was 23,467 MW (2019), 24,287 MW (2020), 27,994 MW (2021), 29,475 MW (2022) and 30,150 MW (2023), i.e. 23.5 / 24.3 / 28.0 / 29.5 / 30.2 GW. Every one fell at hour 15 or 16.
   - On none of these days is the maximum over hours 17-24 the day's peak.
   - The days are flat, with a load factor of 0.89-0.94.
   - Other summer profiles vary more:
     - Typical summer non-working days peak at hour 15 (2019), 1 (2020), 16 (2021), 17 (2022) and 23 (2023), so 2 of 5 peak in the evening window.
     - The summer days of maximum demand peaked at 26,252 / 28,179 / 28,650 / 30,231 / 30,189 MW (2019-2023), at hours 15 / 15 / 16 / 15 / 17.
2. **Summer evenings dip at dusk and then rise again at night.**
   - On all five typical summer working days, demand falls from the afternoon maximum to a trough at hour 19. The fall is 2,592 / 4,690 / 2,497 / 2,245 / 2,441 MW (2019-2023), i.e. 2.2-4.7 GW.
   - Demand then climbs again: by 1,484 MW to hour 22 (2019), 816 MW to hour 21 (2020), 1,654 MW to hour 23 (2021), 881 MW to hour 20 (2022) and 2,043 MW to hour 24 (2023).
   - The night maximum stays below the afternoon maximum on all five days.
   - Measured from the midday window to the evening window, the summer working-day evening ramp is only 0-1.3 GW (0 / 1,098 / 1,116 / 1,126 / 1,291 MW). That window measure misses the dusk trough.
   - On the other 10 summer profiles (non-working days and days of maximum demand), the night rise after the 18-20 h minimum is 351-3,087 MW.
   - The tables do not show why demand dips at dusk.
3. **The old "evening ramp 2.4-2.6 GW at 410-470 MW/h" was a morning-to-afternoon rise.** On summer working days it is the climb from hour 10 to the afternoon peak: 2,560 MW (2021, hours 10-16), 2,476 MW (2022, hours 10-16) and 2,360 MW (2023, hours 10-15), i.e. 413-472 MW/h.
4. **The old "2020 summer peak 21.0 GW" was wrong.** 21,028 MW is the hour-17 value. The 20-07-2020 typical summer working day peaks at 24,287 MW at hour 15.
5. **Winter has a real evening peak.**
   - On all five typical winter working days, the evening maximum is the day's peak, at hour 18-19 (15,753 to 18,713 MW, i.e. 15.8-18.7 GW).
   - From the midday minimum at hour 13-14, demand rises by 1,270 / 1,948 / 1,824 / 1,480 MW in 2019 / 2020 / 2022 / 2023, i.e. 254-390 MW/h.
   - The 2021 profile, which NEPRA prints with a July date (23-07-2021), rises by 2,343 MW (586 MW/h).
   - The 2023 profile is the same column as the 2023 day of maximum winter demand.
6. **On working days, the steepest ramps are winter mornings.**
   - The largest 3-hour rise on typical winter working days is 3,154-3,985 MW (3.2-4.0 GW), starting at hour 4-5. In 2023 it is +3,985 MW from hour 4 to hour 7.
   - Typical summer working days reach 1,494-2,484 MW.
7. **Storage on the 2023 typical summer working day** (22-08-2023, maximum 30,150 MW at hour 15):
   - **95% cap (28,642.5 MW).**
     - The battery needs 1,507.5 MW of power.
     - Demand is above the cap for 9 hours, in two blocks (hours 13-17 and 21-24), so the daily discharge is 7,495.5 MWh.
     - The battery can recharge in hours 18-20, between the blocks. The smallest storage that holds the cap day after day is therefore 6,254.85 MWh (about 6.25 GWh), 17% less than the daily discharge.
     - The cap is feasible within the day.
   - **90% cap (27,135 MW).**
     - It would take 3,015 MW and 28,977 MWh of daily discharge.
     - But 18 of the 24 hours are above the cap. The 6 hours below it can absorb only 2,867 MWh of charging, which stores 2,580 MWh after losses.
     - The cap therefore cannot be held day after day.
   - **Lowest holdable cap:** 93.8% of the maximum (about 28.28 GW); 93.78% with unlimited charging power.
8. **Across 2019-2023 (15 summer and 15 winter profiles):**
   - **Feasibility.**
     - A 90% cap is within-day feasible on only 1 of 15 summer profiles (the 2020 typical working day).
     - A 95% cap is feasible on 13 of 15. The exceptions are the 2019 typical non-working day and the 2022 day of maximum summer demand.
     - All 15 winter profiles are feasible at both caps.
   - **Lowest holdable cap:** 82.4-88.9% of the day maximum in winter, versus 89.8-96.3% in summer.
   - **Recharge energy limits the summer caps.** With unlimited charging power, the summer lowest cap falls by at most 1.0 percentage point, and by nothing on 8 of 15 summer profiles. In winter the charging-power limit binds on all 15 profiles, by 0.01-1.8 points.
   - **Minimum storage vs daily discharge.** On 22 of the 44 feasible profile-cap pairs, recharging between above-cap blocks brings the minimum storage below the daily discharge. The largest saving is 22%: on the 2021 typical summer working day at 95%, 4,569.5 MWh of storage covers 5,823.6 MWh of daily discharge.
   - **Quoting the old figures.**
     - The old "3.0 GW / 29 GWh for a 90% cap" must not be quoted without the caveat that this cap cannot be held.
     - A "1.5 GW / 7.5 GWh" figure for 95% is power and daily discharge, not storage size.
9. **Ember's solar share includes Ember's estimate of distributed solar.**
   - Ember methodology v1.6, Pakistan section: "Monthly generation data is taken from NEPRA. Distributed Solar generation is not captured in these statistics and is estimated by Ember". Distributed fossil generation is also not captured.
   - The old figure label "utility-scale only, rooftop NOT included" was therefore wrong.
   - Ember does not publish the distributed component separately in this dataset, so the rooftop part of the share cannot be read from it.
   - Ember's "Demand" (generation + net imports; net imports are zero in this series) also includes the estimate.
   - **Annual solar share of generation:** 2.1% (2019), 3.2% (2020), 4.1% (2021), 5.4% (2022), 8.1% (2023), 13.9% (2024) and 22.5% (2025). These are sums of the monthly series. Ember's annual dataset takes annual generation from the EIA and may differ.
   - **Monthly maximum:** 34.63% (Feb 2026). The series runs from Nov 2018 to Mar 2026.
10. **Scope caveats.**
    - **What the table does not say.** It does not say whether its hour labels are hour-ending, whether K-Electric's system is included, or how load-shedding is treated.
    - **What the figures are.** They are six representative days per year, not a full hourly year. The storage numbers are for a battery that repeats one such day; they are not a dispatch study.
    - **Timing.** The days are from 2019-2023, before most of the rooftop build-out: Ember's solar share was 8.1% in 2023 and 22.5% in 2025. They cannot show any change that rooftop solar has made to the daily shape since.
    - **Source-table quirks.**
      - The 2021 typical winter working day is printed as 23-07-2021, outside NEPRA's Dec-Feb winter.
      - The 2023 typical winter working day is the same column as the 2023 day of maximum winter demand (26-01-2023).

## Checks

- **Old atlas.** Parsed values match the previous atlas at all 48 trough/peak points it reported (git HEAD `m3_nepra_ramp_atlas.csv`) once the old 0-based positions are shifted by +1. So the old hour numbers were 0-based positions, not NEPRA labels.
- **Parsed values.** There are 720 values (5 years x 6 profiles x 24 hours), and every one is between 5 and 45 GW. The parser stops with an error on any missing hour or date.
- **Minimum storage.** `min_storage_mwh` agrees with a linear program (scipy HiGHS) and with the largest cyclic-window deficit to within 0.0001 MWh on all 44 feasible profile-cap pairs.
- **Lowest holdable cap.** `min_cap_frac` agrees with a brute-force scan at a 0.00001 step.
- **Consistency.** `05_nepra_ramp_atlas.py` stops if `feasible` disagrees with `cap_frac >= min_cap_frac`, if `min_storage_mwh` exceeds the daily discharge, or if the free-charge cap exceeds the power-limited cap.
- **Statements.** Every number above was recomputed from `m3_nepra_hourly_typical_days.csv` without importing `flexibility.py`, and compared with the atlas and storage tables.

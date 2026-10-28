"""NEPRA State of Industry (SoI) reports -> tidy CSV of the typical-day hourly system demand.

Usage (from the repo root):
    python -I scripts/parse_nepra_soi.py [PK_DIR]
PK_DIR defaults to $INVISIBLE_SOLAR_DATA/pk and must hold nepra_soi_<report year>.pdf.
Each PDF is converted with `pdftotext -layout` (poppler-utils or xpdf; Git for Windows ships
it at /mingw64/bin/pdftotext) to nepra_soi_<year>.txt next to it, then the table
'Hourly System Demand (MW) (January - December, <data year>)' is parsed. The SoI report of
year N carries calendar year N-1 (report 2024 -> 2023 data).

Output: PK_DIR/derived/nepra_hourly_typical_days.csv with columns
    year (data year), report, profile, date (dd-mm-yyyy as printed), hour (1..24), demand_mw
Six profiles per year, in NEPRA's column order: max_summer, max_winter (days of maximum
demand), summer_working, summer_nonworking, winter_working, winter_nonworking (typical days).
Hour labels are NEPRA's printed 1..24 (some years print 01:00..24:00, 2023 prints the last
hour as 0:00; both are mapped to 24).

The 'Monthly System Peak Demand' table is not extracted: its layout staggers the newest
fiscal-year columns across half rows, so values cannot be assigned to months reliably."""
from __future__ import annotations
import csv
import glob
import os
import re
import shutil
import subprocess
import sys

PROFILES = ["max_summer", "max_winter", "summer_working", "summer_nonworking", "winter_working", "winter_nonworking"]
TITLE = re.compile(r"Hourly System Demand \(MW\) \(January (?:-|to) December, (\d{4})\)")
DATE = re.compile(r"\((\d{2}-\d{2}-\d{4})\)")
# an hour label (1..24, 01:00, 0:00) followed by exactly six comma-grouped MW values at line end
ROW = re.compile(r"(?:^|\s)(\d{1,2})(?::00)?((?:\s+\d{1,3}(?:,\d{3})+){6})\s*$")


def find_pdftotext() -> str:
    exe = shutil.which("pdftotext")
    git = shutil.which("git")
    if exe is None and os.name == "nt" and git:  # Git for Windows: <root>\cmd\git.exe, <root>\mingw64\bin\pdftotext.exe
        cand = os.path.join(os.path.dirname(os.path.dirname(git)), "mingw64", "bin", "pdftotext.exe")
        exe = cand if os.path.exists(cand) else None
    if exe is None:
        sys.exit("pdftotext not found. Install poppler-utils (apt install poppler-utils / brew install poppler) "
                 "or use Git Bash on Windows (/mingw64/bin/pdftotext), then rerun.")
    return exe


def pdfs_to_text(pk_dir: str) -> list[str]:
    """Run pdftotext -layout on every nepra_soi_*.pdf whose .txt is missing or older."""
    pdfs = sorted(glob.glob(os.path.join(pk_dir, "nepra_soi_*.pdf")))
    if not pdfs:
        sys.exit(f"no nepra_soi_*.pdf in {pk_dir}; see data/README.md for the download links")
    exe = None
    for pdf in pdfs:
        txt = pdf[:-4] + ".txt"
        if os.path.exists(txt) and os.path.getmtime(txt) >= os.path.getmtime(pdf):
            continue
        exe = exe or find_pdftotext()
        subprocess.run([exe, "-layout", "-enc", "UTF-8", pdf, txt], check=True)
        print("pdftotext ->", os.path.basename(txt))
    return [p[:-4] + ".txt" for p in pdfs]


def parse_report(txt: str) -> list[dict]:
    lines = open(txt, encoding="utf-8", errors="replace").read().split("\n")
    report = re.search(r"nepra_soi_(\d{4})", os.path.basename(txt)).group(1)
    rows = []
    for i, ln in enumerate(lines):
        m = TITLE.search(ln)
        if not m:
            continue
        year = m.group(1)
        # dates may be printed on one line or split over two; order them by column position
        dates, k = [], i + 1
        while k < len(lines) and not ROW.search(lines[k]):
            dates += [(d.start(), d.group(1)) for d in DATE.finditer(lines[k])]
            k += 1
        dates = [d for _, d in sorted(dates)]
        if len(dates) != 6:
            raise ValueError(f"{txt}: expected 6 profile dates for {year}, found {dates}")
        got = {}
        for ln2 in lines[k:k + 60]:
            r = ROW.search(ln2)
            if not r:
                continue
            hour = int(r.group(1)) or 24
            got[hour] = [float(v.replace(",", "")) for v in r.group(2).split()]
            if len(got) == 24:
                break
        if sorted(got) != list(range(1, 25)):
            raise ValueError(f"{txt}: hours parsed for {year}: {sorted(got)}")
        for hour in range(1, 25):
            for prof, date, v in zip(PROFILES, dates, got[hour]):
                if not 5_000 <= v <= 45_000:
                    raise ValueError(f"{txt}: implausible {v} MW ({year} {prof} h{hour})")
                rows.append(dict(year=int(year), report=int(report), profile=prof, date=date, hour=hour, demand_mw=v))
    return rows


def build(pk_dir: str) -> str:
    rows = []
    for txt in pdfs_to_text(pk_dir):
        got = parse_report(txt)
        print(f"{os.path.basename(txt)}: {len(got)} rows, data years {sorted({r['year'] for r in got}) or 'none'}")
        rows += got
    years = [r["year"] for r in rows if r["hour"] == 1 and r["profile"] == PROFILES[0]]
    if len(years) != len(set(years)):
        raise ValueError(f"data year present in more than one report: {years}")
    out = os.path.join(pk_dir, "derived")
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "nepra_hourly_typical_days.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["year", "report", "profile", "date", "hour", "demand_mw"])
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: (r["year"], PROFILES.index(r["profile"]), r["hour"])))
    print("wrote", path, len(rows), "rows, years", sorted(set(years)))
    return path


if __name__ == "__main__":
    default = os.path.join(os.environ.get("INVISIBLE_SOLAR_DATA", "data"), "pk")
    build(sys.argv[1] if len(sys.argv) > 1 else default)

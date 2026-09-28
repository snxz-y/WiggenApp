"""
shifts_sync.py - Work calendar (iCal) -> shifts.json for WiggenApp.

Called from garmin_sync.py on every run (HA box cron). Reads the shift calendar's
iCal URL from env SHIFTS_ICS_URL or from shifts_ics_url.txt next to this file
(keep that file OUT of the repo: the URL is a private link to the calendar).
If neither exists the sync is skipped.

One entry per date: {date, shiftName, start, end, shiftType, unit}. Entries from
the first date in the feed onwards are rebuilt from the calendar (days without
events become "off"); older entries in shifts.json are kept as history.
"""
import base64, json, os, re
from datetime import date, datetime, timedelta
import requests

REPO = "snxz-y/WiggenApp"
HERE = os.path.dirname(os.path.abspath(__file__))


def _ics_url():
    url = os.environ.get("SHIFTS_ICS_URL", "").strip()
    if not url:
        path = os.path.join(HERE, "shifts_ics_url.txt")
        if os.path.exists(path):
            url = open(path, encoding="utf-8").read().strip()
    return url.replace("webcal://", "https://", 1) if url else ""


# ── Europe/Oslo offset without tzdata (the HA add-on may not ship zoneinfo) ────
def _last_sunday(year, month):
    d = date(year, month + 1, 1) - timedelta(days=1) if month < 12 else date(year, 12, 31)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def _utc_to_oslo(dt):
    y = dt.year
    dst_start = datetime.combine(_last_sunday(y, 3), datetime.min.time()) + timedelta(hours=1)
    dst_end = datetime.combine(_last_sunday(y, 10), datetime.min.time()) + timedelta(hours=1)
    return dt + timedelta(hours=2 if dst_start <= dt < dst_end else 1)


def _parse_dt(prop, value):
    """Return (local datetime or date, is_all_day)."""
    if "VALUE=DATE" in prop and "VALUE=DATE-TIME" not in prop or re.fullmatch(r"\d{8}", value):
        return datetime.strptime(value[:8], "%Y%m%d").date(), True
    if value.endswith("Z"):
        return _utc_to_oslo(datetime.strptime(value[:15], "%Y%m%dT%H%M%S")), False
    return datetime.strptime(value[:15], "%Y%m%dT%H%M%S"), False   # TZID=Europe/Oslo or floating


def _unescape(v):
    return v.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def parse_ics(text):
    lines = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    events, cur = [], None
    for line in lines:
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            if cur is not None and cur.get("STATUS", "").upper() != "CANCELLED" and "DTSTART" in cur:
                events.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            prop, value = line.split(":", 1)
            name = prop.split(";", 1)[0].upper()
            if name in ("DTSTART", "DTEND"):
                cur[name] = _parse_dt(prop.upper(), value.strip())
            elif name in ("SUMMARY", "DESCRIPTION", "STATUS"):
                cur[name] = _unescape(value.strip())
    return events


def _classify(summary, desc, start, all_day):
    s = summary.strip()
    if all_day:
        if s.lower().startswith("ferie") or "FraværFE" in desc:
            return "vacation"
        return "off"                       # F1, F2, other absences
    h = start.hour
    if h < 11:
        return "day"
    if h < 19:
        return "evening"
    return "night"


def build_shifts(events):
    """Map events to one entry per date (dict date -> entry)."""
    by_date = {}
    for e in events:
        start, all_day = e["DTSTART"]
        end = e.get("DTEND", (None, all_day))[0]
        summary, desc = e.get("SUMMARY", ""), e.get("DESCRIPTION", "")
        unit = (re.search(r"Orgenhet:\s*([^,]+)", desc) or [None, None])[1]
        stype = _classify(summary, desc, start, all_day)
        if all_day:
            last = (end - timedelta(days=1)) if isinstance(end, date) and end > start else start
            days = [start + timedelta(days=i) for i in range((last - start).days + 1)]
            times = (None, None)
        else:
            days = [start.date()]
            times = (start.strftime("%H:%M"), end.strftime("%H:%M") if isinstance(end, datetime) else None)
        for d in days:
            entry = {"date": d.isoformat(), "shiftName": summary, "start": times[0], "end": times[1],
                     "shiftType": stype, "unit": unit.strip() if unit else None}
            prev = by_date.get(entry["date"])
            by_date[entry["date"]] = _pick(prev, entry) if prev else entry
    return by_date


def _pick(a, b):
    """Two events on one date: a real shift beats an all-day marker, vacation
    beats F1/F2; for a
    loan pair ("FL fra DSKBS1" + "(FL til HMO)") keep the one naming the unit
    actually worked."""
    if (a["start"] is None) != (b["start"] is None):
        return a if a["start"] else b
    if a["start"] is None and "vacation" in (a["shiftType"], b["shiftType"]):
        return a if a["shiftType"] == "vacation" else b
    if b["shiftName"].startswith("(FL til") and not a["shiftName"].startswith("(FL til"):
        return b
    return a


def merge(existing, by_date):
    if not by_date:
        return existing
    first, last = min(by_date), max(by_date)
    kept = [e for e in existing if e.get("date", "") < first]
    d, stop, fresh = date.fromisoformat(first), date.fromisoformat(last), []
    while d <= stop:
        k = d.isoformat()
        fresh.append(by_date.get(k) or {"date": k, "shiftName": "", "start": None, "end": None,
                                         "shiftType": "off", "unit": None})
        d += timedelta(days=1)
    return sorted(kept + fresh, key=lambda e: e["date"])


def sync_shifts(gh_headers):
    url = _ics_url()
    if not url:
        print("\nShifts: no SHIFTS_ICS_URL / shifts_ics_url.txt, skipping.")
        return
    print("\nSyncing shifts from calendar...")
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    by_date = build_shifts(parse_ics(r.text))
    print(f"  Calendar: {len(by_date)} days with events")
    if not by_date:
        print("  Empty feed, leaving shifts.json unchanged.")
        return
    api = f"https://api.github.com/repos/{REPO}/contents/shifts.json"
    g = requests.get(api, headers=gh_headers, timeout=15)
    existing, sha = ([], None)
    if g.ok:
        j = g.json()
        existing, sha = json.loads(base64.b64decode(j["content"])), j["sha"]
    new = merge(existing, by_date)
    if new == existing:
        print("  shifts.json: no changes.")
        return
    body = {"message": f"Shifts sync {date.today().isoformat()}",
            "content": base64.b64encode(json.dumps(new, indent=2, ensure_ascii=False).encode("utf-8")).decode()}
    if sha:
        body["sha"] = sha
    p = requests.put(api, headers=gh_headers, json=body, timeout=15)
    print(f"  shifts.json: {'OK' if p.ok else 'FAILED ' + str(p.status_code)} ({len(new)} days, {min(by_date)}..{max(by_date)})")

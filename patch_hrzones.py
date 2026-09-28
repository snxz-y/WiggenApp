"""Legger til henting av pulssoner fra Garmin i garmin_sync.py.

Lagrer sonegulvene som "hrZones" i hver health.json-oppforing:
  {"z1": 104, "z2": 125, "z3": 146, "z4": 166, "z5": 187, "max": 199, "method": "..."}
index.html leser nyeste hrZones og bruker dem i stedet for hardkodede verdier.

Kan kjores flere ganger (hopper over hvis allerede patchet). Finner selv
/config/garmin/garmin_sync.py pa HA-boksen, ellers garmin_sync.py i gjeldende mappe.
Fungerer ogsa via stdin:  ... | ssh ... "sudo python3 -"
"""
import os, sys

TARGET = "/config/garmin/garmin_sync.py" if os.path.exists("/config/garmin/garmin_sync.py") else "garmin_sync.py"
if not os.path.exists(TARGET):
    sys.exit(f"Fant ikke {TARGET}")

src = open(TARGET, encoding="utf-8").read()
if "hrZones" in src:
    print(f"{TARGET}: allerede patchet, ingen endring.")
    sys.exit(0)

FETCH_ANCHOR = '    race_raw = gget(f"{BASE}/metrics-service/metrics/racepredictions/latest", hdrs) or {}\n'
FETCH_CODE = FETCH_ANCHOR + '''    hrz_raw  = gget(f"{BASE}/biometric-service/heartRateZones", hdrs) or []

    # Pulssoner: Garmin gir en rad per sport (DEFAULT, RUNNING, CYCLING ...).
    # Bruk DEFAULT, ellers RUNNING, ellers forste rad. Lagre sonegulvene.
    hr_zones = None
    try:
        rows = hrz_raw if isinstance(hrz_raw, list) else [hrz_raw]
        rows = [r for r in rows if isinstance(r, dict) and r.get("zone1Floor")]
        pick = (next((r for r in rows if r.get("sport") == "DEFAULT"), None)
                or next((r for r in rows if r.get("sport") == "RUNNING"), None)
                or (rows[0] if rows else None))
        if pick:
            hr_zones = {f"z{i}": int(pick[f"zone{i}Floor"]) for i in range(1, 6)}
            hr_zones["max"] = pick.get("maxHeartRateUsed")
            hr_zones["method"] = pick.get("trainingMethod")
    except Exception as e:
        print(f"  HR zones parse error: {e}")
    print(f"  HR zones: {hr_zones}")
'''

ENTRY_ANCHOR = '        "recoveryTimeHrs": _recovery_hrs,\n'
ENTRY_CODE = ENTRY_ANCHOR + '        "hrZones": hr_zones,\n'

for anchor, name in ((FETCH_ANCHOR, "henting"), (ENTRY_ANCHOR, "entry")):
    if src.count(anchor) != 1:
        sys.exit(f"{TARGET}: fant ikke ankeret for {name} (antall={src.count(anchor)}). Ingen endring gjort.")

open(TARGET + ".bak_hrzones", "w", encoding="utf-8").write(src)
src = src.replace(FETCH_ANCHOR, FETCH_CODE).replace(ENTRY_ANCHOR, ENTRY_CODE)
compile(src, TARGET, "exec")
open(TARGET, "w", encoding="utf-8").write(src)
print(f"{TARGET}: patchet OK (backup: {TARGET}.bak_hrzones)")

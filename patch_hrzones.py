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

import re

FETCH_CODE = '''    hrz_raw  = gget(f"{BASE}/biometric-service/heartRateZones", hdrs) or []

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

# Ankeret er starten paa health-oppforingen i sync_health():
#     entry = {
#         "date": TARGET,
ANCHOR = re.compile(r'^(    entry = \{\r?\n)([ \t]+)("date": TARGET,\r?\n)', re.M)
matches = ANCHOR.findall(src)
if len(matches) != 1:
    sys.exit(f"{TARGET}: fant ikke ankeret 'entry = {{ / \"date\": TARGET' (antall={len(matches)}). Ingen endring gjort.")

open(TARGET + ".bak_hrzones", "w", encoding="utf-8").write(src)
src = ANCHOR.sub(lambda m: FETCH_CODE + m.group(1) + m.group(2) + m.group(3) + m.group(2) + '"hrZones": hr_zones,\n', src)
compile(src, TARGET, "exec")
open(TARGET, "w", encoding="utf-8").write(src)
print(f"{TARGET}: patchet OK (backup: {TARGET}.bak_hrzones)")

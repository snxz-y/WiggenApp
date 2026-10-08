#!/usr/bin/env python3
"""WiggenApp watchdog for the Home Assistant box.

Runs from cron next to garmin_sync.py and sends ONE notification to the phone
(through Home Assistant's notify service) when a data flow has stopped, and one
when it is back:

  * health.json   not updated for > 3 h during the day  -> Garmin sync is down
  * nutrition.json not updated for > 36 h               -> the «Wiggen kosthold»
                                                           shortcut has not run

Config: /config/garmin/ha_watch.json
  {
    "notify": "mobile_app_iphone",        # HA notify service name (without "notify.")
    "ha_url": "http://homeassistant:8123", # only needed when SUPERVISOR_TOKEN is absent
    "ha_token": "<long-lived access token>"
  }
The GitHub token is taken from GH_PAT in the environment, or from ha_garmin.py
(the same wrapper the Garmin sync uses) so nothing has to be stored twice.

Cron (every 30 min, 06–23): */30 6-23 * * * cd /config/garmin && python3 ha_watch.py >> watch.log 2>&1
"""
import json, os, re, sys, time
from datetime import datetime, timezone
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = "snxz-y/WiggenApp-data"
CONFIG = os.path.join(HERE, "ha_watch.json")
STATE = os.path.join(HERE, "watch_state.json")
CHECKS = [  # file, max age (hours), message when stale, message when back
    ("health.json", 3, "Garmin-synken har stoppet: health.json er {age} gammel. Sjekk sync.log på HA-boksen.",
     "Garmin-synken går igjen."),
    ("nutrition.json", 36, "Ingen kosthold mottatt på {age}. Åpne MacroFactor så snarveien «Wiggen kosthold» kjører.",
     "Kostholdet kommer inn igjen."),
]


def gh_token():
    tok = os.environ.get("GH_PAT")
    if tok:
        return tok
    try:  # ha_garmin.py sets os.environ["GH_PAT"] = "..." before running the sync
        src = open(os.path.join(HERE, "ha_garmin.py")).read()
        m = re.search(r"GH_PAT[\"']?\]?\s*=\s*[\"']([^\"']+)[\"']", src)
        if m:
            return m.group(1)
    except OSError:
        pass
    sys.exit("No GitHub token: set GH_PAT or keep ha_garmin.py next to this script")


def last_commit_age_h(path, token):
    r = requests.get(f"https://api.github.com/repos/{REPO}/commits", params={"path": path, "per_page": 1},
                     headers={"Authorization": f"token {token}", "User-Agent": "wiggen-watch"}, timeout=20)
    r.raise_for_status()
    items = r.json()
    if not items:
        return None
    ts = datetime.fromisoformat(items[0]["commit"]["committer"]["date"].replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - ts).total_seconds() / 3600


def fmt_age(h):
    return f"{int(round(h))} t" if h < 48 else f"{h / 24:.1f} døgn".replace(".", ",")


def notify(cfg, title, message):
    service = cfg.get("notify", "notify")
    sup = os.environ.get("SUPERVISOR_TOKEN")
    if sup:  # inside an add-on with homeassistant_api: no long-lived token needed
        url, token = "http://supervisor/core/api", sup
    else:
        url, token = cfg.get("ha_url", "http://homeassistant:8123").rstrip("/") + "/api", cfg.get("ha_token")
        if not token:
            sys.exit("ha_watch.json needs ha_token (or run inside the add-on with SUPERVISOR_TOKEN)")
    r = requests.post(f"{url}/services/notify/{service}", json={"title": title, "message": message},
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, timeout=20)
    r.raise_for_status()


def main():
    cfg = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    token = gh_token()
    changed = False
    for path, max_h, stale_msg, ok_msg in CHECKS:
        try:
            age = last_commit_age_h(path, token)
        except Exception as e:
            print(f"{time.strftime('%F %T')} {path}: could not read GitHub ({e})")
            continue
        stale = age is not None and age > max_h
        was = state.get(path, {}).get("stale", False)
        print(f"{time.strftime('%F %T')} {path}: {fmt_age(age) if age is not None else 'no commits'} old, stale={stale}")
        if stale != was:
            try:
                notify(cfg, "WiggenApp", stale_msg.format(age=fmt_age(age)) if stale else ok_msg)
                state[path] = {"stale": stale, "since": time.strftime('%F %T')}
                changed = True
            except Exception as e:
                print(f"  notify failed: {e}")
    if changed:
        json.dump(state, open(STATE, "w"), indent=1)


if __name__ == "__main__":
    main()

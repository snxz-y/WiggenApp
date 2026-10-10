#!/usr/bin/env python3
"""WiggenApp watchdog for the Home Assistant box.

Runs from cron next to garmin_sync.py and sends ONE notification to the phone
(through Home Assistant's notify service) when a data flow has stopped, and one
when it is back:

  * no «Health sync» commit for > 3 h                   -> Garmin sync is down
  * nutrition_debug.json not written for > 36 h         -> the «Wiggen kosthold»
                                                           shortcut has not run

Setup (writes /config/garmin/ha_watch.json and sends a test notification):
  python3 ha_watch.py --setup mobile_app_<phone> <long-lived HA token> [http://192.168.10.103:8123]
  python3 ha_watch.py --test          # send a test notification again
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
# What to watch: (label, how to find the last run, max age in hours, message when stale, message when back)
#   kind "message": newest commit whose message starts with the prefix (the Garmin sync commits every
#   15 min even when nothing changed, so a path filter would miss it); kind "path": newest commit that
#   changed that file (the shortcut rewrites nutrition_debug.json on every run).
CHECKS = [
    ("Garmin-synk", ("message", "Health sync"), 3,
     "Garmin-synken har stoppet: siste kjøring var for {age} siden. Sjekk sync.log på HA-boksen.",
     "Garmin-synken går igjen."),
    ("Kosthold", ("path", "nutrition_debug.json"), 36,
     "Ingen kosthold mottatt på {age}. Åpne MacroFactor så snarveien «Wiggen kosthold» kjører.",
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


def last_commit_age_h(how, token):
    kind, what = how
    params = {"per_page": 1, "path": what} if kind == "path" else {"per_page": 60}
    r = requests.get(f"https://api.github.com/repos/{REPO}/commits", params=params,
                     headers={"Authorization": f"token {token}", "User-Agent": "wiggen-watch"}, timeout=20)
    r.raise_for_status()
    items = r.json()
    if kind == "message":
        items = [c for c in items if c["commit"]["message"].startswith(what)]
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
            raise RuntimeError("ha_watch.json mangler ha_token (kjør: python3 ha_watch.py --setup <notify> <token>)")
    r = requests.post(f"{url}/services/notify/{service}", json={"title": title, "message": message},
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}, timeout=20)
    r.raise_for_status()


def main():
    args = sys.argv[1:]
    if args[:1] == ["--setup"]:  # python3 ha_watch.py --setup mobile_app_xxx <long-lived token> [ha_url]
        if len(args) < 3:
            sys.exit("bruk: ha_watch.py --setup <notify-tjeneste> <ha_token> [ha_url]")
        cfg = {"notify": args[1].replace("notify.", ""), "ha_token": args[2], "ha_url": args[3] if len(args) > 3 else "http://192.168.10.103:8123"}
        json.dump(cfg, open(CONFIG, "w"), indent=1)
        os.chmod(CONFIG, 0o600)
        notify(cfg, "WiggenApp", "Vakthunden er satt opp. Du får beskjed hvis Garmin-synken eller kostholdet stopper.")
        print("ha_watch.json lagret og testvarsel sendt")
        return
    cfg = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    if args[:1] == ["--test"]:
        notify(cfg, "WiggenApp", "Testvarsel fra vakthunden")
        print("sendt")
        return
    state = json.load(open(STATE)) if os.path.exists(STATE) else {}
    token = gh_token()
    changed = False
    for label, how, max_h, stale_msg, ok_msg in CHECKS:
        try:
            age = last_commit_age_h(how, token)
        except Exception as e:
            print(f"{time.strftime('%F %T')} {label}: could not read GitHub ({e})")
            continue
        stale = age is not None and age > max_h
        was = state.get(label, {}).get("stale", False)
        print(f"{time.strftime('%F %T')} {label}: siste kjøring for {fmt_age(age) if age is not None else '?'} siden, stale={stale}")
        if stale != was:
            try:
                notify(cfg, "WiggenApp", stale_msg.format(age=fmt_age(age)) if stale else ok_msg)
                state[label] = {"stale": stale, "since": time.strftime('%F %T')}
                changed = True
            except Exception as e:
                print(f"  varsel feilet: {e}")
    if changed:
        json.dump(state, open(STATE, "w"), indent=1)


if __name__ == "__main__":
    main()

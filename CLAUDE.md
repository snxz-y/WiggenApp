# WiggenApp — Project Reference

## What it is
Personal health & training dashboard. Live at **https://snxz-y.github.io/WiggenApp/**. GitHub repo: `snxz-y/WiggenApp`. Single-page app (`index.html`), **all UI text in Norwegian (bokmål, `lang="nb"`)** — write any new UI text in Norwegian. Seven tabs: Helse, Innsikt, Aktiviteter, Kosthold, Målsetninger, Jobb, Kalender. Dark theme, lime (`#c8f53a`) + purple (`#7c6dfa`) accents.

## Owner context
Jørgen, born 18 June 1997 (the app computes age from `BIRTH_DATE` in `index.html`), 171cm, ~76kg, goal 65kg. Shift nurse in Trondheim, Norway. Dairy allergy. Garmin Epix Pro Gen 2. HR zones and lactate threshold come from Garmin (see below); nothing zone-related is hardcoded in the app anymore. Nutrition targets: 1600 kcal, 150g protein, 145g carbs, 51g fat.

## Source of truth
The GitHub repo is the source of truth for all code. The Windows folder `C:\Users\Jørgen\Documents\files\` is only a working copy, so don't treat files there as canonical. Garmin MCP tokens for Cowork: `C:\Users\Jørgen\.garmin-mcp\` (oauth1, oauth2, profile).

## Repo files
- `index.html` — the whole app. `manifest.json` + `icon-*.png` — PWA metadata.
- `sw.js` — **kill switch only** (clears caches + unregisters a service worker briefly registered in June 2026). `index.html` does not register a service worker. Can be deleted after a while.
- `garmin_sync.py` — the Garmin sync that runs on the HA box (repo copy == box copy). At the end of each run it calls `shifts_sync.py`.
- `shifts_sync.py` — shift calendar (iCal) → `shifts.json`. Must sit next to `garmin_sync.py` on the box.
- `worker.js` — source of the Cloudflare Worker (must be pasted into Cloudflare manually to deploy).
- `activities.json`, `health.json`, `nutrition.json`, `reviews.json`, `shifts.json` — data.
- `scriptable/WiggenKalender.js` — iOS home-screen calendar widget (Scriptable app).
- `.github/workflows/pages-deploy.yml` — deploys GitHub Pages when site files change.

## Garmin-derived settings (not hardcoded)
- **Lactate threshold:** `lactateHR`, `lactatePaceSec`, `lactatePower` in each `health.json` entry (from `/biometric-service/biometric/latestLactateThreshold`). Shown on the Health tab.
- **HR zones:** `hrZones` = `{z1..z5 (zone floors, bpm), max, method}` from `/biometric-service/heartRateZones` (DEFAULT sport, else RUNNING). `index.html` loads the newest entry with `hrZones` into `HRZ` (`setHRZones()`), falling back to 104/125/146/166/187 if none exist. Used for HR colouring, max-HR highlighting, Insights zone legend and readiness advice. As of 27 Sept 2026 Garmin reports HR_MAX-based zones: Z1 99, Z2 118, Z3 138, Z4 158, Z5 177, max 197.
- **Load-focus target ranges:** `aerobicLowMin/Max`, `aerobicHighMin/Max`, `anaerobicMin/Max` come from Garmin's training-load-balance data (old fixed numbers as fallback).
- **Age:** computed in the app from `BIRTH_DATE`.

## Data files in GitHub repo
- `activities.json` — workouts
- `health.json` — daily Garmin metrics (complete from June 14; body-comp only before)
- `nutrition.json` — macros from Kaloridagboken
- `reviews.json` — saved goals (Målsetninger tab; entries with `kind: 'coach'`)

## Automation
- **Garmin sync (runs on the Home Assistant box):** As of 22 June 2026 the sync runs on the always-on HA box (HA OS, `192.168.10.103:8123`) via the **Advanced SSH & Web Terminal** add-on (slug `a0d7b954_ssh`). Files live in `/config/garmin/`: `garmin_sync.py`, `ha_garmin.py` (wrapper — sets `USERPROFILE` so `TOKEN_DIR=./.garmin-mcp`, and sets `GH_PAT`), and the `.garmin-mcp/` token files (`oauth1_token.json`, `oauth2_token.json`, `profile.json`). `requests` is pip-installed in the add-on. It runs in **local mode** (reads/refreshes the cached OAuth2 token on disk), so the OAuth1→OAuth2 exchange only happens when the token nears expiry — avoiding Garmin 429 at 15-min frequency.
  - **Schedule:** busybox cron in the add-on, `*/15 6-23 * * *` plus `0 0 * * *` = every 15 min 06:00–24:00 Norway local time (the box clock is local). Crontab stored at `/config/garmin/crontab`; log at `/config/garmin/sync.log`.
  - **Reboot persistence:** the add-on's **init_commands** reload the crontab and start crond on every boot (`crontab /config/garmin/crontab`, `crond -b -L /config/garmin/cron-daemon.log`) — verified surviving an add-on restart.
  - **SSH access:** key-based from the Windows PC (`~/.ssh/id_ed25519`, added to the add-on's `ssh.authorized_keys`). Connect with `ssh -c aes256-gcm@openssh.com hassio@192.168.10.103` (or `ssh ha` if the `~/.ssh/config` alias is set up). Patches are applied with `curl -s <raw url> | sudo python3 -` on the box.
  - **Deploying `garmin_sync.py` changes:** edit and push the repo file, then on the PC run `ssh -c aes256-gcm@openssh.com hassio@192.168.10.103 "sudo cp /config/garmin/garmin_sync.py /config/garmin/garmin_sync.py.bak && sudo curl -sf https://raw.githubusercontent.com/snxz-y/WiggenApp/<commit-sha>/garmin_sync.py -o /config/garmin/garmin_sync.py"` (use the commit SHA, not `main`, to avoid raw-CDN caching). Don't patch the box copy in place any more, so the two can't drift apart.
  - **No cloud sync:** the GitHub Actions `garmin-sync.yml` workflow and the cloud (OAuth1-from-env) mode in `garmin_sync.py` were deleted in Sept 2026. There is no Windows Task Scheduler task either.
  - **Activities are upserted, not skipped:** `sync_activities` re-processes the last ~2 days every run. It inserts new activities, repairs partial/foreign-schema entries (e.g. ones hand-added via Garmin MCP that lack `distanceM`), and refreshes metrics Garmin computes minutes after a run (power, running dynamics, HR zones, VO2max, load). Do **not** hand-write activity entries with a custom schema — let the sync own `activities.json`.
- **On-demand sync:** removed. The in-app "Sync Garmin" button (and its `triggerGarminSync()` handler) was deleted on 22 June 2026 because the HA box now auto-syncs every 15 min, and the old button dispatched the now-disabled `garmin-sync.yml` workflow. For a manual sync, run `python3 /config/garmin/ha_garmin.py` on the HA box (e.g. via the SSH add-on web terminal).
- **Shifts (Jobb tab):** `shifts_sync.py` runs with every Garmin sync (every 15 min). It downloads the shift calendar's iCal feed (the same one Google Calendar imports as «94327_calendar»), keeps one entry per date (`date, shiftName, start, end, shiftType, unit`), rebuilds everything from the feed's first date onwards (days without events = `off`), keeps older history, and pushes `shifts.json` only when something changed. The iCal URL is private: it lives only in `/config/garmin/shifts_ics_url.txt` (gitignored) or env `SHIFTS_ICS_URL`; without it the step is skipped. Rules: all-day `Ferie`/`FraværFE` = vacation, other all-day (F1/F2) = off, timed start <11 = day, <19 = evening, else night. Loan pairs (`FL fra DSKBS1` + `(FL til X)`) collapse to the `(FL til X)` entry.
- **Nutrition:** Health Auto Export iPhone app → Cloudflare Worker → GitHub. Syncs every 6h. Widget on home screen keeps it reliable.
- **Cloudflare Worker:** `https://nutrition-reciever.margidowiggen.workers.dev` — handles `/` (nutrition from Health Auto Export), `/save-review` + `/delete-review` (Målsetninger tab) and `/calendar`. Secrets: `GITHUB_TOKEN`, `CAL_KEY`, `CAL_FEEDS`. All GitHub writes go through `updateRepoJson()` (UTF-8 safe, retries on sha conflicts). Source is `worker.js` in the repo; deploy by pasting it into the Cloudflare dashboard.

## Kalender (private calendar overview)
**The repo and GitHub Pages site are public**, so calendar data must never be written to the repo. The Kalender tab instead calls the Worker's `POST /calendar {key, from, to}`. The Worker fetches every iCal feed in the `CAL_FEEDS` secret (JSON: `[{"name":"Privat","url":"https://calendar.google.com/calendar/ical/.../private-.../basic.ics","color":"#7c6dfa"}, ...]`, `color` optional), expands recurring events (RRULE daily/weekly/monthly/yearly, EXDATE, RECURRENCE-ID overrides), converts to Oslo time and returns only the requested window (max 400 days). It answers only if `key` matches the `CAL_KEY` secret. The app stores the password in localStorage on each device (the «Lås» button forgets it). Two views (choice remembered in localStorage): **Liste** (21-day agenda) and **Måned** (month grid; on phones the cells show coloured dots, on wide screens event chips; tapping a day lists it below). Tapping any event opens a detail sheet with date/time, calendar, location (Google Maps link) and the full description (Google's HTML descriptions are converted to plain text, scripts stripped, URLs made clickable). Per-calendar show/hide chips (hidden set in localStorage). Responses are cached in memory per date range until the page reloads. A feed that fails shows ⚠ on its chip. Google calendars use their «Secret address in iCal format»; calendars subscribed from a URL (the shift calendar, the course timetable) use their original URL; Norwegian holidays use Google's public holiday iCal URL.

**Home-screen widget:** `scriptable/WiggenKalender.js` is a Scriptable (iOS) widget that calls the same `/calendar` endpoint (password in the iOS Keychain, set by running the script once in Scriptable) and shows the list view in app colours; small/medium/large sizes. Tapping it opens `https://snxz-y.github.io/WiggenApp/#kalender`. iOS opens that in Safari, not the home-screen web app, so the password must also be entered once in Safari. The app supports hash deep links: `#kalender`, `#helse`, `#innsikt`, `#aktiviteter`, `#kosthold`, `#mal`, `#jobb`.

## Målsetninger (formerly Reviews)
The old AI-generated weekly reviews are gone. The Målsetninger tab lets Jørgen write or paste goals (optional title + text); they are saved via the Worker's `/save-review` to `reviews.json` and shown as collapsible accordions with delete. `/generate-review` (Claude API) was removed from the Worker in Sept 2026.

## Removed features
- **Zyn tracking** — removed from the app (Sept 2026). Don't re-add.
- **In-app "Sync Garmin" button** — removed (see Automation).

## Key behaviors
- Dates display DD/MM/YYYY everywhere via custom date picker (pill-shaped button, opens dark calendar popup). Defaults to today minus 1 day.
- Health & Nutrition tabs: single date picker, no Apply button (applies on select).
- Macro split shows two donuts: Mål (left) vs Faktisk (right).
- Training readiness feedback codes are translated to plain Norwegian.
- Activity tab keys in code stay English (`runs`, `bikes`, `walks`, `all`) — only visible labels are Norwegian. Translating the keys broke the Løping/Gåturer tables once (fixed Sept 2026).

## Push command (standard)
Push via the GitHub contents API with `$env:GH_PAT`, sending the JSON body as UTF-8 bytes (PowerShell 5 otherwise mangles æøå):
```powershell
$repo="snxz-y/WiggenApp"; $file="index.html"
$h=@{Authorization="token $env:GH_PAT";Accept="application/vnd.github.v3+json";"User-Agent"="wt"}
$c=[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\$file"))
$sha=(Invoke-RestMethod "https://api.github.com/repos/$repo/contents/$file" -Headers $h).sha
$b=@{message="update $file";content=$c;sha=$sha}|ConvertTo-Json
Invoke-RestMethod "https://api.github.com/repos/$repo/contents/$file" -Headers $h -Method PUT -Body ([Text.Encoding]::UTF8.GetBytes($b)) -ContentType "application/json; charset=utf-8" | Out-Null
```

## Getting run feedback remotely
If PC is on + Claude Desktop running, use **Cowork** from iPhone: fetch latest run via Garmin MCP and trigger a manual sync on the HA box (`ssh ... "cd /config/garmin && sudo python3 ha_garmin.py"`) instead of waiting up to 15 min. Without the MCP (plain Claude app), read `https://raw.githubusercontent.com/snxz-y/WiggenApp/main/activities.json` — but only AFTER a sync has pushed the run.

# WiggenApp — Project Reference

## What it is
Personal health & training dashboard. Live at **https://snxz-y.github.io/WiggenApp/**. GitHub repo: `snxz-y/WiggenApp`. Single-page app (`index.html`), **all UI text in Norwegian (bokmål, `lang="nb"`)** — write any new UI text in Norwegian. Seven tabs, in this order: Helse, Innsikt, Aktiviteter, Kosthold, Søvn, Kalender, Målsetninger. Dark theme, lime (`#c8f53a`) + purple (`#7c6dfa`) accents.

## Owner context
Single owner/user. Personal details (birth date, goal weight, nutrition targets, background) are deliberately **not** in this public repo: settings the app needs live in `profile.json` and owner context in `PROFILE.md`, both in the private repo `snxz-y/WiggenApp-data`. Garmin Epix Pro Gen 2. HR zones and lactate threshold come from Garmin (see below); nothing zone-related is hardcoded in the app anymore.

## Private data (Sept 2026)
- **This repo (`snxz-y/WiggenApp`) is PUBLIC and must contain no personal data.** All data lives in the **private** repo **`snxz-y/WiggenApp-data`**: `health.json`, `activities.json`, `nutrition.json`, `reviews.json`, `profile.json` (birthDate, goalWeight, bodyFatGoal, nutrition `targets`; read into `PROFILE`/`TARGETS` by `loadData()`). Never hardcode personal values in `index.html`.
- Writers: HA box `garmin_sync.py` (REPO = WiggenApp-data) and the Worker (nutrition + goals).
- Reader: the app calls the Worker's `POST /data {key}`; the Worker reads the private repo with `GITHUB_TOKEN`. The app shows a password screen on first open (password = Worker secret `CAL_KEY`, stored in localStorage `calKey`, shared with Kalender). «Lås» logs out.
- Goals (`/save-review`, `/delete-review`) also require the password. **Every Worker endpoint requires the password** (the old open Health Auto Export `POST /` was removed in Oct 2026).
- Plain Claude chat reads the data through the Worker's MCP server (custom connector «Wiggen»), or via Cowork + Garmin MCP, or a Claude Code session with WiggenApp-data attached.

## Source of truth
The GitHub repo is the source of truth for all code. The Windows folder `%USERPROFILE%\Documents\files\` is only a working copy, so don't treat files there as canonical. Garmin MCP tokens for Cowork: `%USERPROFILE%\.garmin-mcp\` (oauth1, oauth2, profile).

## Repo files
- `index.html` — the whole app. `manifest.json`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (180px, used by iPhone home screen) — app icon (Wiggen flower logo, Oct 2026). Icons are linked with `?v=N`; bump N when the icon changes.
- `sw.js` — **kill switch only** (clears caches + unregisters a service worker briefly registered in June 2026). `index.html` does not register a service worker. Can be deleted after a while.
- `garmin_sync.py` — the Garmin sync that runs on the HA box (repo copy == box copy).
- `worker.js` — source of the Cloudflare Worker (must be pasted into Cloudflare manually to deploy).
- Data files are NOT here — see «Private data» above.
- `scriptable/WiggenKalender.js` — iOS home-screen calendar widget (Scriptable app).
- `ha_watch.py` — watchdog for the HA box (see Automation). `icons/wiggen-dag.png` — home-screen icon for the «Wiggen dag» shortcuts.
- `.github/workflows/pages-deploy.yml` — deploys GitHub Pages when site files change.

## Garmin-derived settings (not hardcoded)
- **Lactate threshold:** `lactateHR`, `lactatePaceSec`, `lactatePower` in each `health.json` entry (from `/biometric-service/biometric/latestLactateThreshold`). Shown on the Health tab.
- **HR zones:** `hrZones` = `{z1..z5 (zone floors, bpm), max, method}` from `/biometric-service/heartRateZones` (DEFAULT sport, else RUNNING). `index.html` loads the newest entry with `hrZones` into `HRZ` (`setHRZones()`), falling back to 104/125/146/166/187 if none exist. Used for HR colouring, max-HR highlighting, Insights zone legend and readiness advice. As of 27 Sept 2026 Garmin reports HR_MAX-based zones: Z1 99, Z2 118, Z3 138, Z4 158, Z5 177, max 197.
- **Load-focus target ranges:** `aerobicLowMin/Max`, `aerobicHighMin/Max`, `anaerobicMin/Max` come from Garmin's training-load-balance data (old fixed numbers as fallback).
- **Age:** computed in the app from `PROFILE.birthDate` (profile.json).

## Data files (in the private repo WiggenApp-data)
- `activities.json` — workouts
- `health.json` — daily Garmin metrics (complete from June 14; body-comp only before)
- `nutrition.json` — daily macros (MacroFactor → Apple Health → «Wiggen kosthold» shortcut → Worker); `nutrition_debug.json` — last shortcut payload
- `reviews.json` — saved goals (Målsetninger tab; entries with `kind: 'coach'`)
- `reminders.json` — `{updatedAt, items:[{title, due ('YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'), list}]}`, the open iOS Påminnelser sent by the «Wiggen dag» shortcut (see Dagen)

## Automation
- **Garmin sync (runs on the Home Assistant box):** As of 22 June 2026 the sync runs on the always-on HA box (HA OS, `192.168.10.103:8123`) via the **Advanced SSH & Web Terminal** add-on (slug `a0d7b954_ssh`). Files live in `/config/garmin/`: `garmin_sync.py`, `ha_garmin.py` (wrapper — sets `USERPROFILE` so `TOKEN_DIR=./.garmin-mcp`, and sets `GH_PAT`), and the `.garmin-mcp/` token files (`oauth1_token.json`, `oauth2_token.json`, `profile.json`). `requests` is pip-installed in the add-on. It runs in **local mode** (reads/refreshes the cached OAuth2 token on disk), so the OAuth1→OAuth2 exchange only happens when the token nears expiry — avoiding Garmin 429 at 15-min frequency.
  - **Schedule:** busybox cron in the add-on, `*/15 6-23 * * *` plus `0 0 * * *` = every 15 min 06:00–24:00 Norway local time (the box clock is local). Crontab stored at `/config/garmin/crontab`; log at `/config/garmin/sync.log`.
  - **Reboot persistence:** the add-on's **init_commands** reload the crontab and start crond on every boot (`crontab /config/garmin/crontab`, `crond -b -L /config/garmin/cron-daemon.log`) — verified surviving an add-on restart.
  - **SSH access:** key-based from the Windows PC (`~/.ssh/id_ed25519`, added to the add-on's `ssh.authorized_keys`). Connect with `ssh -c aes256-gcm@openssh.com hassio@192.168.10.103` (or `ssh ha` if the `~/.ssh/config` alias is set up). Patches are applied with `curl -s <raw url> | sudo python3 -` on the box.
  - **Deploying `garmin_sync.py` changes:** edit and push the repo file, then on the PC run `ssh -c aes256-gcm@openssh.com hassio@192.168.10.103 "sudo cp /config/garmin/garmin_sync.py /config/garmin/garmin_sync.py.bak && sudo curl -sf https://raw.githubusercontent.com/snxz-y/WiggenApp/<commit-sha>/garmin_sync.py -o /config/garmin/garmin_sync.py"` (use the commit SHA, not `main`, to avoid raw-CDN caching). Don't patch the box copy in place any more, so the two can't drift apart.
  - **No cloud sync:** the GitHub Actions `garmin-sync.yml` workflow and the cloud (OAuth1-from-env) mode in `garmin_sync.py` were deleted in Sept 2026. There is no Windows Task Scheduler task either.
  - **Activities are upserted, not skipped:** `sync_activities` re-processes the last ~2 days every run. It inserts new activities, repairs partial/foreign-schema entries (e.g. ones hand-added via Garmin MCP that lack `distanceM`), and refreshes metrics Garmin computes minutes after a run (power, running dynamics, HR zones, VO2max, load). Do **not** hand-write activity entries with a custom schema — let the sync own `activities.json`.
- **On-demand sync:** removed. The in-app "Sync Garmin" button (and its `triggerGarminSync()` handler) was deleted on 22 June 2026 because the HA box now auto-syncs every 15 min, and the old button dispatched the now-disabled `garmin-sync.yml` workflow. For a manual sync, run `python3 /config/garmin/ha_garmin.py` on the HA box (e.g. via the SSH add-on web terminal).
- **No work/shift data in the repo.** The repo is public, so shift schedules (and any calendar data) must never be committed. `shifts.json` and `shifts_sync.py` were removed in Sept 2026; the calendar is only reachable through the private Worker `/calendar` endpoint.
- **Nutrition (Oct 2026):** the iOS shortcut **«Wiggen kosthold»** (Snarveier) reads Apple Health — Find Health Samples, *Group by Day*, last 7 days — for kostenergi, protein, karbohydrater, fett, fiber, mettet fett, sukker, and POSTs a flat JSON body (`key`, `dates` (shared list, Fill Missing on) or `<field>_dates`, `calories`, `calories_unit`, `protein`, `carbs`, `fat`, `fiber`, `saturatedFat`, `sugar`) to the Worker's `/nutrition-shortcut` (password). The Worker accepts lists or newline text, Norwegian number/date formats and energy in J (Shortcuts default), kJ or kcal, replaces each day's totals, and stores the last raw payload in `nutrition_debug.json` (private repo) for troubleshooting. Zero values are ignored (never overwrite). Identical payloads within 2 min are acknowledged without writing (the «app closed» automation fires in bursts), and a GitHub write failure still answers HTTP 200 with `ok:false` so iOS doesn't show «Automatisering feilet» — the next run re-sends the same 7 days. Food is logged in **MacroFactor** (since Oct 2026), which writes nutrition to Apple Health.
  - **Automation (iPhone):** trigger on **«Når MacroFactor åpnes»** (phone is unlocked, so Health is readable). Do **not** use a time-of-day trigger: Apple Health is encrypted while the phone is locked, so «Finn helseprøver» fails and iOS reports «Automatisering feilet» (the 22:00 trigger never produced a single commit). «Når MacroFactor lukkes» also fails whenever «closed» means «phone locked».
- Health Auto Export is gone (it crashed on launch in Oct 2026 and caused missing days 2–3 Oct; the open `POST /` endpoint was removed from the Worker). Nutrition between 2 Aug and 29 Sep 2026 is missing in `nutrition.json`.
- **Watchdog (HA box):** `ha_watch.py` runs from cron (`*/30 6-23 * * *`) next to the sync, reads the last commit time of `health.json` (> 3 h = Garmin sync down) and `nutrition.json` (> 36 h = shortcut not running) and sends one HA notification per incident + one when recovered (state in `watch_state.json`). Config `ha_watch.json` {notify, ha_url, ha_token}; inside the add-on `SUPERVISOR_TOKEN` is used instead of a long-lived token when present. GitHub token from `GH_PAT` or parsed from `ha_garmin.py`.
- **Cloudflare Worker:** `https://nutrition-reciever.margidowiggen.workers.dev` — handles `/nutrition-shortcut`, `/agenda`, `/data`, `/save-review` + `/delete-review` (Målsetninger tab), `/calendar` and the MCP server `/mcp/<MCP_KEY>`. Secrets: `GITHUB_TOKEN`, `CAL_KEY`, `CAL_FEEDS`, `MCP_KEY`. All GitHub writes retry up to 5 times with backoff on sha conflicts. Secrets: `GITHUB_TOKEN`, `CAL_KEY`, `CAL_FEEDS`. All GitHub writes go through `updateRepoJson()` (UTF-8 safe, retries on sha conflicts). Source is `worker.js` in the repo; deploy by pasting it into the Cloudflare dashboard.

## Design (Claude Design overhaul, Sept 2026)
- The visual layer came from Claude Design: a **"v2" CSS layer at the bottom of `<style>`** overrides the older rules. Change styling there rather than in the old rules above it.
- Mobile (≤680px): the tab bar is a **fixed bottom nav** (CSS only; `viewport-fit=cover` + safe-area insets). `showNav()` scrolls to top and sets the header suffix (`#logo-tab`, «Wiggen / Kosthold»). Desktop keeps the top nav.
- Sub-tabs are a segmented control (44px). On ≤480px labels may wrap; Aktiviteter stacks icon over text.
- Shared classes: `eyebrow`, `chart-title`, `card-title`, `card-note`, `form-card`, `field`, `btn-primary`, `icon-btn`, `date-row`/`date-field`. Tokens `--r-card`, `--r-inner`, `--tap`, `--nav-h`, `--glass`.
- Chart.js defaults are set by `applyChartDefaults()` (Hanken Grotesk 11px, line width 2). Chart heights: 160 small / 180 standard / 200 multi-series. Series palette: #c07a52, #647bb0, #5a9a6c, #b48f2c, #8a7bd8, #c0594e.

## App conventions (Sept 2026 cleanup)
- **Periods:** shared `rangeChips(active, fnName, opts)` renders period chips (7 d / 14 d / 30 d / 3 mnd / Alt). Defaults: Kosthold 14 d, Kosthold→Trender kaloriunderskudd 14 d + ukedagsnitt 8 uker, Helse→Trender 3 mnd, Kropp 1 mnd, Søvn 30 d, Innsikt 3 mnd (intensitet 30 d).
- **Dates:** chart axes are always DD/MM (`ddmm()`), tables DD/MM/YYYY (`ddmmyyyy()`). Irregular series (weigh-ins, body fat, Kropp) use a real time axis (`dayNum()` + `dayAxis()`), not one slot per measurement.
- **Layout:** side-by-side charts use `.chart-pair` (one column under 680px); stat tiles are 2 columns on phones.
- **Garmin terms stay in English** (owner's wish): metric names (Training Readiness, Sleep Score, Recovery Time, HRV Status, Training Status, Acute/Chronic Load, Training Load Focus, Endurance Score, Fitness Age, Lactate Threshold, Intensity Minutes, Body Battery, Respiration) and Garmin's status values (Overreaching, Balanced, Moderate, Low Aerobic Shortage …, title-cased by `garminLabel()`). Explanatory text around them is Norwegian. `readinessFeedback()` decodes `<level> RT <recovery time left> SS <sleep score> [modifiers]` (e.g. `POOR RT HIGH SS POOR` = poor readiness, much recovery time left, poor sleep).
- **Readiness in correlations** uses the *morning* value (`morningReadiness()` = first reading in `trainingReadinessSeries`); the stored `trainingReadiness` is the day's latest reading.
- **Søvn tab** (`renderSleep()`): Oversikt (averages, sleep window, duration, stages, night table), Sammenheng (sleep measure × same-day health measure scatter + strongest pairs), Sammenlign (period A vs B table with better/worse colouring). Bedtimes before 12:00 are treated as the previous evening (+24 h) when averaging. Sleep-stage colours are validated for colour-blind separation (`--st-*` tokens).

## Kalender (private calendar overview)
**The repo and GitHub Pages site are public**, so calendar data must never be written to the repo. The Kalender tab instead calls the Worker's `POST /calendar {key, from, to}`. The Worker fetches every iCal feed in the `CAL_FEEDS` secret (JSON: `[{"name":"Privat","url":"https://calendar.google.com/calendar/ical/.../private-.../basic.ics","color":"#7c6dfa"}, ...]`, `color` optional), expands recurring events (RRULE daily/weekly/monthly/yearly, EXDATE, RECURRENCE-ID overrides), converts to Oslo time and returns only the requested window (max 400 days). It answers only if `key` matches the `CAL_KEY` secret. The app stores the password in localStorage on each device (the «Lås» button forgets it). Two views (choice remembered in localStorage): **Liste** (21-day agenda) and **Måned** (month grid; on phones the cells show coloured dots, on wide screens event chips; tapping a day lists it below). Tapping any event opens a detail sheet with date/time, calendar, location (Google Maps link) and the full description (Google's HTML descriptions are converted to plain text, scripts stripped, URLs made clickable). Per-calendar show/hide chips (hidden set in localStorage). Responses are cached in memory per date range until the page reloads. A feed that fails shows ⚠ on its chip. Google calendars use their «Secret address in iCal format»; calendars subscribed from a URL (the shift calendar, the course timetable) use their original URL; Norwegian holidays use Google's public holiday iCal URL.

**Home-screen widget:** `scriptable/WiggenKalender.js` is a Scriptable (iOS) widget that calls the same `/calendar` endpoint (password in the iOS Keychain, set by running the script once in Scriptable) and shows the list view in app colours; small/medium/large sizes. Tapping it opens `https://snxz-y.github.io/WiggenApp/#kalender`. iOS opens that in Safari, not the home-screen web app, so the password must also be entered once in Safari. The app supports hash deep links: `#kalender`, `#helse`, `#innsikt`, `#aktiviteter`, `#kosthold`, `#sovn`, `#mal`.

## Dagen («Hva skal jeg i dag?», Oct 2026)
- **Worker `POST /agenda {key, day, titles, dues, lists, titles_overdue, dues_overdue, lists_overdue}`**: `day` is spoken language («i dag», «i morgen», «denne uka», «helga», a weekday, a date). Reminder lists (aligned lists or newline text, Norwegian dates, «00:00» = no time) replace `reminders.json`; when omitted the stored ones are used. Fetches the calendar feeds (`fetchCalendars()`), today's health + nutrition + profile, and answers `{message, speech, events, reminders, day}`: `message` for screens (emoji lines: 🗓 events, ✅ reminders due, ⚠️ overdue, 💪 readiness/sleep/recovery/kcal left, ⏱ free slots ≥ 90 min between 08–21), `speech` for Siri (no emoji).
- **Shortcuts (iPhone):** «Wiggen dag» (input text = day; Find Reminders not completed, due next 14 days + last 60 days; POST /agenda; Stop and Output). «Hva skal jeg i dag» / «… i morgen» run it and Show Result of `speech`, so Siri reads it. Optional automation «Når Påminnelser lukkes → Wiggen dag» keeps reminders fresh. Recipe: `oppskrift-wiggen-dag.md` (outside the repo). Icon: `icons/wiggen-dag.png`.
- **App:** `todayCardHtml()` renders the «I dag» card at the top of Helse → I dag (only when the selected date is today): Readiness, Sleep Score, Recovery Time, kcal left (`TARGETS.calories` − today's nutrition), the `insMakeCall()` advice, then `loadTodayAgenda()` fetches `/calendar` for today..+2 (10-min cache `agendaCache`) and `drawTodayAgenda()` lists today/tomorrow events, reminders due, overdue ones and free slots. `remindersCardHtml()` lists all open reminders at the top of Kalender → Liste. `REMINDERS` is set from `reminders.json` in `applyFiles()`.

## MCP-server («Spør dataene dine», Oct 2026)
- The Worker is also a **Streamable-HTTP MCP server** at `POST /mcp` (`handleMcp()`): stateless JSON-RPC (`initialize`, `ping`, `tools/list`, `tools/call`, batches; notifications → 202; GET → 405).
- **Auth, two ways:** (1) **OAuth 2.1** for claude.ai custom connectors (web + iPhone app) and Claude Code: the Worker is its own stateless authorization server — `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `POST /register` (dynamic client registration; client_id = signed blob with the redirect_uris), `GET/POST /authorize` (login page asking for the **app password** CAL_KEY; 302 back with a 5-min code), `POST /token` (authorization_code with PKCE S256, refresh_token). Access tokens last 30 days, refresh 180; all are HMAC-signed with `MCP_KEY`, so rotating `MCP_KEY` revokes everything. Unauthenticated `/mcp` answers 401 + `WWW-Authenticate: Bearer resource_metadata=…`. (2) The secret in the URL: `/mcp/<MCP_KEY>` (for tools that can't do OAuth). `MCP_KEY` is a Cloudflare secret (long random string); it falls back to `CAL_KEY` only if unset — set it.
- Connect: claude.ai → Settings → Connectors → Add custom connector → URL `https://nutrition-reciever.margidowiggen.workers.dev/mcp` → log in with the app password. Claude Code: `claude mcp add --transport http wiggen https://nutrition-reciever.margidowiggen.workers.dev/mcp` then `/mcp` to authenticate.
- Tools (all read the private repo through `readRepoJson()`): `get_agenda(day)`, `get_calendar(from,to)`, `get_reminders()`, `get_health(from,to,fields)` (series arrays stripped, max 90 days), `get_sleep(from,to)`, `get_activities(from,to,type)` (splits replaced by `laps` count), `get_activity(activityId)` (with splits), `get_nutrition(from,to)` (+targets), `get_summary(days)` (period vs previous period: training, sleep, readiness, rhr, hrv, steps, nutrition, weight — `summarize()`), `get_profile()`, `get_goals()`, `add_goal(title,text)` (writes reviews.json). Results carry both `content[0].text` (pretty JSON) and `structuredContent`. Tool descriptions are Norwegian with Garmin terms in English.
- `buildAgenda(env, dayText, sentReminders)` is the shared core of `/agenda` and `get_agenda`.
- Tests: `mcptest.mjs` (initialize, list, every tool, auth, batch) and `oauthtest.mjs` (metadata, register, login page, PKCE, token, refresh, revocation).

## Aktiviteter extras (Oct 2026)
- **Detaljark:** every activity row (`.act-row`, all four tables) opens `actOpen(activityId)` — a sheet (same `#cal-sheet`/`.cal-sheet` styling, closes with `calClose()`/Escape) with key stats, HR-zone bar with minutes, the `splits` table (lap, distance, time, pace/speed, HR, elevation), running dynamics and a Garmin Connect link. GC links and the «Mer» button stop propagation.
- **Løpeform over tid** (Oversikt): `renderActForm()` — Race Predictions 5 km/10 km (two axes), VO₂ Max, Lactate Threshold (HR left, pace right/reversed) from the daily `health.json` fields; chips 3 mnd / 6 mnd / Alt (`actFormDays`). `showNav('activities')` re-renders the tab because `destroyCharts()` kills the charts on every tab switch.

## Søvnbalanse (Oct 2026)
Søvn → Oversikt has a «Søvnbalanse 7 netter» card and chart: nightly deviation from `PROFILE.sleepTargetH` (default 7.5 h) as bars, rolling 7-night sum as a line (negative = søvngjeld).

## Startup (Oct 2026)
`startApp()` is cache-first: the last `/data` answer is kept in localStorage `dataCache` (`{at, files}`, ~330 kB). With a cache the app renders immediately (`applyFiles()` + `firstRender()`) and `refreshData()` fetches fresh data in the background, re-rendering the open tab (and moving the Helse date to today if today's entry just arrived). Without a cache it loads as before. «Lås» and a 401 clear the cache. No service worker. `DATA_AT` (shown as «data HH:MM» on the I dag card) is when the displayed data was fetched.

## Målsetninger (formerly Reviews)
The old AI-generated weekly reviews are gone. The Målsetninger tab lets the owner write or paste goals (optional title + text); they are saved via the Worker's `/save-review` to `reviews.json` and shown as collapsible accordions with delete. `/generate-review` (Claude API) was removed from the Worker in Sept 2026.

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

## Testing
Playwright test harnesses live in the session scratchpad (`/tmp/claude-0/pw/`): `smoke.js` (all tabs, both themes, JS errors) and `full.js` (every tab/sub-tab/chip/picker in 390 px + 1280 px, both themes, mocked Worker for `/data`, `/calendar` and goals, login flow, deep links, empty data; checks NaN/undefined text, horizontal overflow and zero-size charts). Run: `DATA=<private repo clone> node full.js <repo>`. The Worker has unit tests with a fake GitHub contents API: `workertest.mjs` (dedupe, bursts, soft failure, joule conversion, goals, `/data`) and `agendatest.mjs` (fake iCal feed + reminders → `/agenda` text for i dag / i morgen / uka / weekday). `cachetest.js` checks the cache-first start; `shot.js` screenshots one tab with mocked data (`EVAL` runs JS first, e.g. to open a sheet).

## Getting run feedback remotely
Use Cowork (Claude Desktop on the PC) with the Garmin MCP, or open a Claude Code session with `snxz-y/WiggenApp-data` attached and read `activities.json` there. The data is no longer readable from raw.githubusercontent.com.

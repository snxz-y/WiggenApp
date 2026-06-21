# WiggenApp — Project Reference

## What it is
Personal health & training dashboard. Live at **https://snxz-y.github.io/WiggenApp/**. GitHub repo: `snxz-y/WiggenApp`. Single-page app (`index.html`) with four tabs: Activities, Health, Nutrition, Reviews. Dark theme, lime (`#c8f53a`) + purple (`#7c6dfa`) accents.

## Owner context
Jørgen, 28, 171cm, ~76kg, goal 65kg. Shift nurse in Trondheim, Norway. Quit Zyn June 5 2026. Dairy allergy. Garmin Epix Pro Gen 2. HR zones: Z1 104-124, Z2 125-145, Z3 146-165, Z4 166-186, Z5 187+. Nutrition targets: 1600 kcal, 150g protein, 145g carbs, 51g fat.

## File locations (Windows PC)
All scripts in `C:\Users\Jørgen\Documents\files\`:
- `index.html` — the site
- `garmin_sync.py` — daily Garmin→GitHub sync, auto-refreshes OAuth token
- `garmin_backfill.py` — one-off historical data backfill
- `sync_log.txt` — sync output log

Garmin MCP tokens: `C:\Users\Jørgen\.garmin-mcp\` (oauth1, oauth2, profile)

## Data files in GitHub repo
- `activities.json` — workouts
- `health.json` — daily Garmin metrics (complete from June 14; body-comp only before)
- `nutrition.json` — macros from Kaloridagboken
- `reviews.json` — saved weekly reviews

## Automation
- **Garmin sync (cloud-only):** Runs entirely in **GitHub Actions** — `.github/workflows/garmin-sync.yml`. Schedule `cron: '*/15 4-22 * * *'` = every 15 min, ~06:00–00:00 Norway (UTC+2), plus `workflow_dispatch`. Syncs even when the PC is off. There is **no** local Task Scheduler task anymore (the old `GarminSync_0600`/`_2300`/`_Frequent` tasks were removed). Note: GitHub free-tier cron is best-effort and can run late or skip slots under load.
  - The job caches the Garmin OAuth2 token between runs (actions/cache `garmin-oauth2`) so the OAuth1→OAuth2 exchange happens ~once/hour, not every run — this is what prevents Garmin 429 rate-limiting at 15-min frequency.
  - `garmin_sync.py` reads the GitHub token from env (`GH_PAT` secret) and Garmin creds from `GARMIN_OAUTH1_TOKEN`/`GARMIN_OAUTH1_SECRET`/`GARMIN_DISPLAY_NAME` secrets. No tokens are hardcoded in the committed file.
  - **Activities are upserted, not skipped:** `sync_activities` re-processes the last ~2 days every run. It inserts new activities, repairs partial/foreign-schema entries (e.g. ones hand-added via Garmin MCP that lack `distanceM`), and refreshes metrics Garmin computes minutes after a run (power, running dynamics, HR zones, VO2max, load). Do **not** hand-write activity entries with a custom schema — let the sync own `activities.json`.
- **On-demand sync:** the "Sync Garmin" button in the app POSTs to the Worker's `/sync-garmin`, which `workflow_dispatch`es `garmin-sync.yml`. The button shows a ~60s countdown, then reloads the data and shows "✓ Updated!".
- **Nutrition:** Health Auto Export iPhone app → Cloudflare Worker → GitHub. Syncs every 6h. Widget on home screen keeps it reliable.
- **Cloudflare Worker:** `https://nutrition-reciever.margidowiggen.workers.dev` — handles `/` (nutrition), `/save-review`, `/generate-review`, `/sync-garmin` (dispatches the Actions workflow). Secrets: `GITHUB_TOKEN`, `ANTHROPIC_KEY`.

## Reviews
Reviews tab calls the Worker's `/generate-review` which calls Claude API (claude-sonnet-4-6). Costs ~$0.01-0.03 per review. Past reviews show as collapsible accordions.

## Key behaviors
- Dates display DD/MM/YYYY everywhere via custom date picker (pill-shaped button, opens dark calendar popup). Defaults to today minus 1 day.
- Health & Nutrition tabs: single date picker, no Apply button (applies on select).
- Macro split shows two donuts: Goal (left) vs Actual (right).
- Training readiness feedback codes translated to plain English.

## Push command (standard)
```powershell
$token="<GITHUB_TOKEN>"
$repo="snxz-y/WiggenApp"
$h=@{Authorization="token $token";Accept="application/vnd.github.v3+json";"Content-Type"="application/json";"User-Agent"="wt"}
$d=(Get-Item -LiteralPath "C:\Users\Jørgen\Documents\files").FullName
$bytes=[System.IO.File]::ReadAllBytes("$d\index.html")
$c=[Convert]::ToBase64String($bytes)
$sha=(Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/index.html" -Headers $h -Method GET).sha
$b=@{message="update";content=$c;sha=$sha}
Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/index.html" -Headers $h -Method PUT -Body($b|ConvertTo-Json -Depth 3)|Out-Null
```

## Getting run feedback remotely
If PC is on + Claude Desktop running, use **Cowork** from iPhone: fetch latest run via Garmin MCP and trigger the sync to update WiggenApp on demand — no waiting for the scheduled 23:00 sync. Without the MCP (plain Claude app), read `https://raw.githubusercontent.com/snxz-y/WiggenApp/main/activities.json` — but only AFTER a sync has pushed the run.

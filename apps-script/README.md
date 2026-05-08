# Apps Script backend

This is the server for the heatmap. It lives inside the Google Sheet "Peenwerder Jagd" so it can read/write the tabs directly without service-account auth.

## One-time deploy

1. Create a Google Sheet named **Peenwerder Jagd** in your Drive.
2. **Extensions → Apps Script** opens the bound script editor.
3. Replace the contents of `Code.gs` with this folder's `Code.gs`. Save.
4. **Bulk-import the hunting posts**:
   - Open `public/posts.json` from this repo, copy the entire JSON array.
   - In Apps Script, find the `setupFromPostsJson` function at the bottom and paste the JSON between the single quotes after `const POSTS_JSON = `.
   - Hit **Run** ▶ next to `setupFromPostsJson`. Approve the permission prompt the first time. The `posts` tab will appear with all 95 rows.
   - You can revert the JSON to `'[]'` after import if you like — it's only used once.
5. **Add hunters**:
   - In the sheet, add a `hunters` tab (or just trigger any read; the script auto-creates it).
   - Column A row 1: `name`. Below it, one hunter name per row.
6. **Deploy as web app**:
   - **Deploy → New deployment → Type: Web app**
   - Description: `Peenwerder Jagd v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, copy the **Web app URL**.
7. Paste that URL into `public/config.js` as `APPS_SCRIPT_URL`.

## How endpoints work

- `GET ?action=bootstrap` → `{ posts: [...], hunters: [...], species: [...] }`
- `GET ?action=aggregates&from=2025-04-01&to=2026-03-31&species=Rehwild` → `[{ post_id, total_count }, ...]`
- `POST` body `{ hunter, post_id, species, count, notes }` → `{ ok: true }` or `{ error: "..." }`

The frontend sends POST with `Content-Type: text/plain` so it stays a "simple" CORS request and Apps Script doesn't need a preflight handler.

## Updating the script

Each time you change `Code.gs`, **Deploy → Manage deployments → pencil icon → New version → Deploy**. The URL stays the same. No frontend redeploy needed.

## Adding a hunter

Just add their name to the `hunters` tab. The bootstrap response will pick it up the next time the page loads.

## Correcting an entry

Edit the `harvests` tab directly. Drive's version history is your safety net.

# Apps Script backend

This is the server for the heatmap. It lives inside the Google Sheet "Peenwerder Jagd" so it can read/write the tabs directly without service-account auth.

## Why this is a manual paste

Google's OAuth policy on the stock `clasp` client silently strips the script-creation scopes for new accounts, so the CLI can't create a bound Apps Script. The setup below takes ~2 minutes in the browser and never has to be repeated.

## One-time setup (8 clicks)

1. Open **https://sheets.new** — a blank Sheet appears. Rename it to **Peenwerder Jagd** (top-left).
2. **Extensions → Apps Script** opens the bound script editor in a new tab.
3. Delete everything in the default `Code.gs` file.
4. Paste the entire contents of [this `Code.gs`](https://raw.githubusercontent.com/zunksimon84/peenwerder-jagd/main/apps-script/Code.gs) (95 hunting posts are inlined as data, so no other files needed). Save with **Cmd+S**.
5. Up top, pick the function dropdown, choose **`setup`**, then click **Run** ▶. Approve the permission prompt the first time (you'll see "Google hasn't verified this app" — click **Advanced → Go to Peenwerder Jagd (unsafe)**, that's just because it's your own private script). When it finishes you'll see an alert "Importiert: 95 Hochsitze."
6. Switch back to the Sheet tab. You'll see three new tabs: `posts` (95 rows), `hunters` (empty), `harvests` (empty). Add hunter names to column A of `hunters`, one per row.
7. Back in the Apps Script tab: **Deploy → New deployment → ⚙ → Web app**.
   - Description: `v1`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, approve again. Copy the **Web app URL** (it ends in `/exec`).
8. Send that URL back to Claude — it'll go into the GitHub repo as a secret and the page will start working.

## How endpoints work

- `GET ?action=bootstrap` → `{ posts: [...], hunters: [...], species: [...] }`
- `GET ?action=aggregates&from=2025-04-01&to=2026-03-31&species=Rehwild` → `[{ post_id, total_count }, ...]`
- `POST` body `{ hunter, post_id, species, count, notes }` with `Content-Type: text/plain` → `{ ok: true, hunter: "..." }` or `{ error: "..." }`. New hunter names are auto-added to the `hunters` tab.

## Updating the script

Each time you change `Code.gs`, **Deploy → Manage deployments → pencil icon → New version → Deploy**. The URL stays the same. No frontend redeploy needed.

## Correcting an entry

Edit the `harvests` tab directly. Drive's version history is your safety net.

## Updating the post list

If Kanzeln are added/moved in the My Map, regenerate `Code.gs` locally:

```bash
node tools/parse-kml.mjs                # rebuild public/posts.json
node tools/bake-apps-script.mjs         # rebuild apps-script/Code.gs (planned helper)
```

Then re-paste the file in the Apps Script editor and run `setup` again — it overwrites the `posts` tab in place; `harvests` rows still reference posts by `id` so existing history is preserved.

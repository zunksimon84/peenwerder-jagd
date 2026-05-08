# Peenwerder Jagd-Heatmap

Mobile-first heatmap of hunting harvests in the Peenwerder Revier, on top of Google Maps. Hunters log what they shot from each Kanzel; the map renders a heatmap weighted by harvest counts.

## Stack

- **Frontend**: vanilla HTML/CSS/JS, Google Maps JS API + Visualization library, hosted on GitHub Pages
- **Backend**: Google Apps Script web app (bound to a Google Sheet)
- **Data**: a single Google Sheet with `posts`, `hunters`, `harvests` tabs

No build step. No framework. ~600 lines total.

## Project layout

```
public/                 # everything Firebase Hosting serves
  index.html
  app.js
  style.css
  posts.json            # baked from KML
  manifest.json
  config.example.js     # copy to config.js, fill in keys (gitignored)
apps-script/
  Code.gs               # paste this into the Apps Script editor on the sheet
  README.md             # deployment steps
tools/
  parse-kml.mjs         # regenerate posts.json from a KML file or URL
```

## First-time setup

### 1. Generate `public/posts.json`

```bash
node tools/parse-kml.mjs
```

This pulls the live Google My Map KML and writes 95 posts to `public/posts.json`. Re-run it any time you add or move Kanzeln in My Maps.

### 2. Create the Google Sheet

Create a Sheet named **Peenwerder Jagd** in your Drive. Then follow [`apps-script/README.md`](apps-script/README.md) to paste `Code.gs` into the bound script editor, run `setupFromPostsJson` once to import the posts, and deploy as a web app.

Add hunter names to the `hunters` tab (one per row, header `name` in row 1).

### 3. Get a Google Maps API key

In your existing GCP project:
1. **APIs & Services → Library** → enable **Maps JavaScript API**
2. **Credentials → Create credentials → API key**
3. **Restrict key**: HTTP referrers → add your Pages URL (e.g. `https://<your-gh-user>.github.io/peenwerder-jagd/*`) plus `http://localhost:*` for local testing
4. **API restrictions**: Maps JavaScript API only

### 4. Wire up `config.js`

```bash
cp public/config.example.js public/config.js
```

Open `public/config.js` and paste in your Maps API key and Apps Script URL.

### 5. Deploy

Pushing to `main` triggers `.github/workflows/pages.yml`, which uploads `public/` to GitHub Pages automatically. After the first push, enable Pages in **Settings → Pages → Source: GitHub Actions** (or via `gh api -X POST /repos/$OWNER/$REPO/pages -f build_type=workflow`).

## Local development

```bash
npx http-server public -p 8080
# or
python3 -m http.server -d public 8080
```

Open `http://localhost:8080`. Make sure `localhost:*` is on the Maps API key referrer allow-list.

## How it works

- **Bootstrap** — on load the page calls `?action=bootstrap` on the Apps Script and gets `{posts, hunters, species}`. It falls back to `posts.json` and an empty hunter list if the backend is unreachable.
- **Heatmap** — markers are rendered for every post. Aggregates are fetched via `?action=aggregates&from=…&species=…` and turned into a `HeatmapLayer` with log-scaled weights. Posts with zero harvests have a marker but no heat.
- **Logging** — tap any marker (or the `+` FAB and "Nächste verwenden") to open the bottom sheet. Submitting POSTs JSON to the same Apps Script URL with `Content-Type: text/plain` (so it stays a CORS-simple request and Apps Script doesn't need a preflight handler).

## Updating posts

If Kanzeln are added/moved in the My Map:

```bash
node tools/parse-kml.mjs        # regenerates public/posts.json
```

Then re-run `setupFromPostsJson` in Apps Script to push the new list into the sheet's `posts` tab. Existing harvest rows reference posts by `id`, so renaming or moving a post is fine; deleting one orphans its history.

## Risks / known limits

- Anyone with the URL can submit harvests as any of the listed hunters. Acceptable for a small trusted group; add a shared-secret header to `Code.gs` if vandalism becomes an issue.
- The Maps JS API key is exposed in the page source. The HTTP-referrer restriction in step 3 is what actually keeps it locked down — don't skip it.
- Apps Script free quota is 20k URL-fetches/day; trivially enough for a hunting club.

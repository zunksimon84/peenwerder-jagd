// Peenwerder Jagd-Heatmap backend
// ---------------------------------
// Bound to the Google Sheet "Peenwerder Jagd". Deploy as Web App with
//   Execute as: Me      Who has access: Anyone
// Then paste the deployment URL into public/config.js as APPS_SCRIPT_URL.

const SPECIES = [
  "Rehwild",
  "Schwarzwild",
  "Rotwild",
  "Damwild",
  "Fuchs",
  "Dachs",
  "Waschbär",
  "Hase",
  "Sonstiges",
];

const SHEETS = {
  posts: "posts",
  hunters: "hunters",
  harvests: "harvests",
};

const POST_HEADER = ["id", "name", "area", "lat", "lng"];
const HUNTER_HEADER = ["name"];
const HARVEST_HEADER = ["timestamp", "hunter", "post_id", "species", "count", "notes", "wind_speed", "wind_dir"];

// ---------- HTTP entrypoints ----------

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = params.action || "bootstrap";
    // Public endpoints — no token needed.
    if (action === "site-status") return json_(siteStatus_());
    if (action === "verify-access") return json_(verifyAccess_(params));
    // Everything else requires a valid token if the site is private.
    if (!checkToken_(params.token)) {
      return json_({ error: "private", code: "AUTH_REQUIRED" });
    }
    if (action === "bootstrap") return json_(bootstrap_());
    if (action === "aggregates") return json_(aggregates_(params));
    if (action === "sync") return json_(syncPostsFromKml());
    if (action === "history") return json_(history_(params));
    if (action === "strecke") return json_(strecke_(params));
    return json_({ error: "unknown action" }, 400);
  } catch (err) {
    return json_({ error: String(err && err.message || err) }, 500);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || "{}");
    if (!checkToken_(body.token)) {
      return json_({ error: "private", code: "AUTH_REQUIRED" });
    }
    const result = logHarvest_(body);
    return json_(result, result.error ? 400 : 200);
  } catch (err) {
    return json_({ error: String(err && err.message || err) }, 500);
  }
}

// ---------- Handlers ----------

function bootstrap_() {
  return {
    posts: readPosts_(),
    hunters: readHunters_(),
    species: SPECIES.slice(),
  };
}

function strecke_(params) {
  const fromIso = params.from || null;
  const toIso = params.to || null;
  const from = fromIso ? new Date(fromIso) : null;
  const to = toIso ? new Date(toIso) : null;

  const rows = readHarvests_();
  const counts = {};
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ts = new Date(r.timestamp);
    if (from && ts < from) continue;
    if (to && ts > to) continue;
    const sp = String(r.species || "").trim();
    if (!sp) continue;
    const n = Number(r.count) || 0;
    counts[sp] = (counts[sp] || 0) + n;
    total += n;
  }
  const by_species = Object.keys(counts)
    .map(function (sp) { return { species: sp, count: counts[sp] }; })
    .sort(function (a, b) { return b.count - a.count; });

  // Per-day counts for the current hunting season, regardless of the
  // filter — the timeline always spans Apr 1 → Mar 31 so the user can see
  // when the season's peak weeks were.
  const seasonStart = seasonStartUtc_(new Date());
  const dailyMap = {};
  for (let j = 0; j < rows.length; j++) {
    const r2 = rows[j];
    const ts = new Date(r2.timestamp);
    if (isNaN(ts) || ts < seasonStart) continue;
    const dayKey = ts.toISOString().slice(0, 10); // YYYY-MM-DD
    const n2 = Number(r2.count) || 0;
    dailyMap[dayKey] = (dailyMap[dayKey] || 0) + n2;
  }
  const daily = Object.keys(dailyMap).sort().map(function (d) {
    return { day: d, count: dailyMap[d] };
  });
  const seasonEnd = new Date(Date.UTC(seasonStart.getUTCFullYear() + 1, 2, 31, 23, 59, 59));

  return {
    by_species: by_species,
    total: total,
    season_start: seasonStart.toISOString(),
    season_end: seasonEnd.toISOString(),
    daily: daily,
  };
}

function history_(params) {
  const post_id = String(params.post_id || "").trim();
  if (!post_id) return [];
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
  const rows = readHarvests_();
  const filtered = rows
    .filter(function (r) { return String(r.post_id).trim() === post_id; })
    .map(function (r) {
      const ts = new Date(r.timestamp);
      const ws = r.wind_speed;
      const wd = r.wind_dir;
      return {
        timestamp: isNaN(ts) ? null : ts.toISOString(),
        hunter: String(r.hunter || ""),
        species: String(r.species || ""),
        count: Number(r.count) || 0,
        notes: String(r.notes || ""),
        wind_speed: ws === "" || ws === null || ws === undefined ? null : Number(ws),
        wind_dir: wd === "" || wd === null || wd === undefined ? null : Number(wd),
      };
    })
    .sort(function (a, b) {
      return (b.timestamp || "").localeCompare(a.timestamp || "");
    })
    .slice(0, limit);
  return filtered;
}

function aggregates_(params) {
  const fromIso = params.from || null;     // inclusive ISO date or datetime
  const toIso = params.to || null;         // inclusive ISO date or datetime
  const species = params.species || null;  // single species or null

  const from = fromIso ? new Date(fromIso) : null;
  const to = toIso ? new Date(toIso) : null;

  const rows = readHarvests_();
  const counts = {};
  for (const r of rows) {
    const ts = new Date(r.timestamp);
    if (from && ts < from) continue;
    if (to && ts > to) continue;
    if (species && r.species !== species) continue;
    counts[r.post_id] = (counts[r.post_id] || 0) + Number(r.count || 0);
  }
  return Object.keys(counts).map(function (post_id) {
    return { post_id: post_id, total_count: counts[post_id] };
  });
}

function logHarvest_(body) {
  const hunter = String(body.hunter || "").trim();
  const speciesVal = String(body.species || "").trim();
  const count = Number(body.count);
  const notes = String(body.notes || "").trim();
  const free = body.free_location || null;
  let post_id = String(body.post_id || "").trim();

  if (!hunter) return { error: "hunter required" };
  if (hunter.length > 40) return { error: "hunter name too long" };
  if (!/^[\p{L}][\p{L}\s.\-']{0,39}$/u.test(hunter)) {
    return { error: "hunter name has invalid characters" };
  }
  if (!speciesVal) return { error: "species required" };
  if (!Number.isFinite(count) || count < 1 || count > 20) {
    return { error: "count must be 1–20" };
  }
  if (SPECIES.indexOf(speciesVal) === -1) {
    return { error: "invalid species" };
  }
  if (!post_id && !free) return { error: "post_id or free_location required" };

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // If a free location was provided (Klettersitz or Pirsch), materialise
  // it as a post so it shows up in aggregates/heatmap like any other.
  let createdPost = null;
  if (free && !post_id) {
    const lat = Number(free.lat);
    const lng = Number(free.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: "free_location.lat out of range" };
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { error: "free_location.lng out of range" };
    const rawLabel = String(free.label || "").trim();
    if (rawLabel.length > 40) return { error: "free_location.label too long" };
    if (rawLabel && !/^[\p{L}\p{N}][\p{L}\p{N}\s.\-_/'"]{0,39}$/u.test(rawLabel)) {
      return { error: "free_location.label has invalid characters" };
    }
    const KIND = {
      klettersitz: { area: "Klettersitz", prefix: "KS-" },
      pirsch:      { area: "Pirsch",      prefix: "P-"  },
    };
    const kindKey = String(free.kind || "klettersitz").toLowerCase();
    const cfg = KIND[kindKey];
    if (!cfg) return { error: "invalid free_location.kind" };
    const niceLabel = rawLabel || (cfg.area + " " + lat.toFixed(4) + ", " + lng.toFixed(4));
    post_id = cfg.prefix + Date.now().toString(36).toUpperCase();
    const sheet = ensureSheet_(ss, SHEETS.posts, POST_HEADER);
    sheet.appendRow([post_id, niceLabel, cfg.area, lat, lng]);
    createdPost = { id: post_id, name: niceLabel, area: cfg.area, lat: lat, lng: lng };
  }

  const posts = readPosts_();
  if (!posts.some(function (p) { return p.id === post_id; })) {
    return { error: "unknown post_id: " + post_id };
  }

  // Auto-add hunter to roster on first use (case-insensitive match).
  const hunters = readHunters_();
  const known = hunters.find(function (h) { return h.toLowerCase() === hunter.toLowerCase(); });
  if (!known) {
    ensureSheet_(ss, SHEETS.hunters, HUNTER_HEADER).appendRow([hunter]);
  }
  const canonical = known || hunter;

  // Resolve harvest time — user can backdate (logging yesterday's hunt
  // today). Falls back to now on missing/invalid input. Reject far-
  // future entries (>1h ahead) and very old (>2 years) as data hygiene.
  let harvestTime = new Date();
  const userTs = String(body.timestamp || "").trim();
  if (userTs) {
    const parsed = new Date(userTs);
    if (!isNaN(parsed)) {
      const diffMs = parsed.getTime() - Date.now();
      const TWO_YEARS_MS = 2 * 365 * 86400000;
      if (diffMs <= 3600000 && diffMs >= -TWO_YEARS_MS) {
        harvestTime = parsed;
      }
    }
  }

  // Pick the lat/lng to query weather for.
  const targetPost = createdPost || posts.find(function (p) { return p.id === post_id; });
  const weather = (targetPost && Number.isFinite(targetPost.lat) && Number.isFinite(targetPost.lng))
    ? fetchWeather_(targetPost.lat, targetPost.lng, harvestTime)
    : null;

  const sheet = ensureSheet_(ss, SHEETS.harvests, HARVEST_HEADER);
  appendByName_(sheet, {
    timestamp: harvestTime.toISOString(),
    hunter: canonical,
    post_id: post_id,
    species: speciesVal,
    count: count,
    notes: notes,
    wind_speed: weather ? weather.wind_speed : "",
    wind_dir: weather ? weather.wind_dir : "",
  });

  const out = { ok: true, hunter: canonical };
  if (createdPost) out.post = createdPost;
  return out;
}

// ---------- Sheet helpers ----------

function readPosts_() {
  const rows = readSheet_(SHEETS.posts, POST_HEADER);
  return rows.map(function (r) {
    return {
      id: String(r.id),
      name: String(r.name),
      area: String(r.area),
      lat: Number(r.lat),
      lng: Number(r.lng),
    };
  });
}

function readHunters_() {
  return readSheet_(SHEETS.hunters, HUNTER_HEADER)
    .map(function (r) { return String(r.name).trim(); })
    .filter(Boolean);
}

function readHarvests_() {
  return readSheet_(SHEETS.harvests, HARVEST_HEADER);
}

function readSheet_(name, expectedHeader) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, name, expectedHeader);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const header = values[0].map(function (c) { return String(c).trim(); });
  return values.slice(1).map(function (row) {
    const obj = {};
    header.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
}

function ensureSheet_(ss, name, header) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(header);
    sheet.getRange(1, 1, 1, header.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
    return sheet;
  }
  // Additive migration: append any header columns the sheet doesn't have
  // yet. Existing column positions are never touched, so old rows keep
  // their data and new rows get the new fields written via appendByName_.
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (s) { return String(s).trim(); })
    : [];
  for (let i = 0; i < header.length; i++) {
    if (existing.indexOf(header[i]) === -1) {
      const newCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, newCol).setValue(header[i]).setFontWeight("bold");
    }
  }
  return sheet;
}

// Append a row by header NAME so we don't depend on column order. The
// sheet's current header is read each call (cheap) so that additive
// migrations or manual reorderings still work.
function appendByName_(sheet, values) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (s) { return String(s).trim(); });
  const row = new Array(header.length).fill("");
  Object.keys(values).forEach(function (key) {
    const i = header.indexOf(key);
    if (i >= 0) row[i] = values[key];
  });
  sheet.appendRow(row);
}

// ---------- KML sync ----------
// Re-fetches the public Peenwerder My Map KML and upserts placemarks
// matching "Nr. X" / "DJB X" inside the four known sub-revier folders into
// the posts tab. New posts are appended; existing ones are updated in
// place if their name/area/coords changed in My Maps. Posts are never
// deleted from the sheet (they carry harvest history). Klettersitz posts
// (hunter-created free locations) are independent of KML and never
// touched by sync.

const KML_URL = "https://www.google.com/maps/d/kml?mid=1Mz4DY_G8uTFDT14YNepjb8vLbjwF6lM&forcekml=1";

const AREA_PREFIX = {
  "Peenwerder Hauptrevier": "HR",
  "Peenwerder Ost": "OST",
  "Peenwerder Nord": "N",
  "Peenwerder Nordrand": "NR",
};

function syncPostsFromKml() {
  const res = UrlFetchApp.fetch(KML_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error("KML fetch failed: HTTP " + res.getResponseCode());
  }
  const fromKml = parseKmlPosts_(res.getContentText());

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.posts, POST_HEADER);
  const lastRow = sheet.getLastRow();
  const existingValues = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, POST_HEADER.length).getValues()
    : [];

  const idToRowIdx = {};
  for (let i = 0; i < existingValues.length; i++) {
    idToRowIdx[String(existingValues[i][0])] = i;
  }

  let added = 0, updated = 0;
  const newRows = [];
  for (let i = 0; i < fromKml.length; i++) {
    const p = fromKml[i];
    const newRow = [p.id, p.name, p.area, p.lat, p.lng];
    if (idToRowIdx[p.id] !== undefined) {
      const cur = existingValues[idToRowIdx[p.id]];
      const changed =
        String(cur[1]) !== p.name ||
        String(cur[2]) !== p.area ||
        Math.abs(Number(cur[3]) - p.lat) > 1e-7 ||
        Math.abs(Number(cur[4]) - p.lng) > 1e-7;
      if (changed) {
        sheet.getRange(idToRowIdx[p.id] + 2, 1, 1, POST_HEADER.length).setValues([newRow]);
        updated++;
      }
    } else {
      newRows.push(newRow);
      added++;
    }
  }
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, POST_HEADER.length).setValues(newRows);
  }
  return { added: added, updated: updated, total: fromKml.length };
}

function parseKmlPosts_(kml) {
  const folders = parseKmlFolders_(kml);
  const out = [];
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i];
    const prefix = AREA_PREFIX[folder.name];
    if (!prefix) continue;
    const placemarks = parseKmlPointPlacemarks_(folder.body);
    for (let j = 0; j < placemarks.length; j++) {
      const pm = placemarks[j];
      if (!isHuntingPostName_(pm.name)) continue;
      const num = postNumber_(pm.name);
      if (!num) continue;
      const isDjb = /^DJB/i.test(pm.name);
      const idCore = (isDjb ? "DJB" : "") + num;
      out.push({
        id: prefix + "-" + idCore.toUpperCase(),
        name: pm.name,
        area: folder.name.replace(/^Peenwerder\s+/, ""),
        lat: pm.lat,
        lng: pm.lng,
      });
    }
  }
  // Suffix duplicate IDs so they remain unique (matches parse-kml.mjs).
  const seen = {};
  for (let k = 0; k < out.length; k++) {
    const id = out[k].id;
    seen[id] = (seen[id] || 0) + 1;
    if (seen[id] > 1) out[k].id = id + "-" + seen[id];
  }
  return out;
}

function parseKmlFolders_(kml) {
  const folders = [];
  const re = /<Folder>([\s\S]*?)<\/Folder>/g;
  let m;
  while ((m = re.exec(kml)) !== null) {
    const body = m[1];
    const nameMatch = body.match(/<name>([^<]+)<\/name>/);
    folders.push({
      name: nameMatch ? decodeXml_(nameMatch[1].trim()) : "Unknown",
      body: body,
    });
  }
  return folders;
}

function parseKmlPointPlacemarks_(body) {
  const out = [];
  const re = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const inner = m[1];
    if (!/<Point>/.test(inner)) continue;
    const nameMatch = inner.match(/<name>([\s\S]*?)<\/name>/);
    const coordMatch = inner.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
    if (!nameMatch || !coordMatch) continue;
    const parts = coordMatch[1].trim().split(",").map(Number);
    if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;
    out.push({ name: decodeXml_(nameMatch[1].trim()), lat: parts[1], lng: parts[0] });
  }
  return out;
}

function decodeXml_(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function isHuntingPostName_(name) {
  return /^(Nr\.?|DJB)\s*\d+/i.test(name);
}

function postNumber_(name) {
  const m = name.match(/^(?:Nr\.?|DJB)\s*([\dA-Za-z]+)/i);
  return m ? m[1] : null;
}

function installPostsSyncTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "syncPostsFromKml") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("syncPostsFromKml").timeBased().everyHours(1).create();
}

// ---------- Weather (Open-Meteo, no key) ----------

function fetchWeather_(lat, lng, when) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const ts = new Date(when);
  if (isNaN(ts)) return null;
  const ageDays = (Date.now() - ts.getTime()) / 86400000;

  // Forecast endpoint covers ~last 92 days plus the current day; archive
  // endpoint goes back to 1940 but lags by ~5 days. Pick whichever fits.
  let url;
  if (ageDays < 5) {
    const past = Math.max(1, Math.ceil(ageDays) + 1);
    url = "https://api.open-meteo.com/v1/forecast"
      + "?latitude=" + lat + "&longitude=" + lng
      + "&hourly=wind_speed_10m,wind_direction_10m"
      + "&past_days=" + past + "&forecast_days=1"
      + "&timezone=UTC&windspeed_unit=kmh";
  } else {
    const dayStr = ts.toISOString().slice(0, 10);
    url = "https://archive-api.open-meteo.com/v1/archive"
      + "?latitude=" + lat + "&longitude=" + lng
      + "&start_date=" + dayStr + "&end_date=" + dayStr
      + "&hourly=wind_speed_10m,wind_direction_10m"
      + "&timezone=UTC&windspeed_unit=kmh";
  }

  try {
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    const data = JSON.parse(resp.getContentText());
    if (!data.hourly || !data.hourly.time || !data.hourly.time.length) return null;
    const targetMs = ts.getTime();
    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < data.hourly.time.length; i++) {
      const t = new Date(data.hourly.time[i] + "Z").getTime();
      const diff = Math.abs(t - targetMs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    const speed = data.hourly.wind_speed_10m[bestIdx];
    const dir = data.hourly.wind_direction_10m[bestIdx];
    if (!Number.isFinite(speed) || !Number.isFinite(dir)) return null;
    return {
      wind_speed: Math.round(speed * 10) / 10,
      wind_dir: Math.round(dir),
    };
  } catch (err) {
    return null;
  }
}

// One-shot helper to fill weather columns on existing harvest rows that
// were logged before the weather feature shipped. Run from the editor:
//   Function dropdown → backfillWeather → ▶
// Stops itself before hitting the per-execution time limit.
function backfillWeather() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.harvests, HARVEST_HEADER);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert("Keine Strecke-Einträge vorhanden.");
    return;
  }
  const lastCol = sheet.getLastColumn();
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (s) { return String(s).trim(); });
  const tsCol = header.indexOf("timestamp") + 1;
  const postCol = header.indexOf("post_id") + 1;
  const wsCol = header.indexOf("wind_speed") + 1;
  const wdCol = header.indexOf("wind_dir") + 1;
  if (!tsCol || !postCol || !wsCol || !wdCol) {
    throw new Error("Missing required columns in harvests sheet");
  }

  const posts = readPosts_();
  const postMap = {};
  for (let i = 0; i < posts.length; i++) postMap[posts[i].id] = posts[i];

  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const start = Date.now();
  let updated = 0;
  let skipped = 0;
  for (let i = 0; i < data.length; i++) {
    if (Date.now() - start > 5 * 60 * 1000) break; // 5 min safety
    const row = data[i];
    const cur = row[wsCol - 1];
    if (cur !== "" && cur !== null && cur !== undefined) { skipped++; continue; }
    const post = postMap[String(row[postCol - 1])];
    if (!post || !Number.isFinite(post.lat)) continue;
    const ts = new Date(row[tsCol - 1]);
    if (isNaN(ts)) continue;
    const w = fetchWeather_(post.lat, post.lng, ts);
    if (!w) continue;
    sheet.getRange(i + 2, wsCol).setValue(w.wind_speed);
    sheet.getRange(i + 2, wdCol).setValue(w.wind_dir);
    updated++;
    Utilities.sleep(150); // be polite to Open-Meteo
  }
  SpreadsheetApp.getUi().alert(
    "Wetter-Backfill: " + updated + " ergänzt, " + skipped + " bereits vorhanden."
  );
}

// ---------- Season rollover ----------
// A hunting season runs Apr 1 → Mar 31. archivePastSeasons() moves any
// harvest rows from earlier seasons into per-season tabs named
// "harvests_2025-26" etc., leaving only the current season in the main
// `harvests` tab. The daily trigger installed by setup() runs this every
// night, so on Apr 1 (and any day after) the rollover happens automatically.

function archivePastSeasons() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.harvests, HARVEST_HEADER);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return { moved: 0 };

  const header = values[0];
  const currentStart = seasonStartUtc_(new Date());

  const keep = [header];
  const buckets = {}; // seasonLabel → [rows]

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const ts = new Date(row[0]);
    if (isNaN(ts) || ts >= currentStart) {
      keep.push(row);
      continue;
    }
    const label = seasonLabel_(ts);
    (buckets[label] = buckets[label] || []).push(row);
  }

  let moved = 0;
  for (const label in buckets) {
    const archive = ensureSheet_(ss, SHEETS.harvests + "_" + label, HARVEST_HEADER);
    const rows = buckets[label];
    archive.getRange(archive.getLastRow() + 1, 1, rows.length, HARVEST_HEADER.length).setValues(rows);
    moved += rows.length;
  }

  if (moved > 0) {
    sheet.clear();
    sheet.getRange(1, 1, keep.length, HARVEST_HEADER.length).setValues(keep);
    sheet.getRange(1, 1, 1, HARVEST_HEADER.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }

  return { moved: moved };
}

function seasonStartUtc_(date) {
  // April 1 of the year the season started in. Months: 0=Jan ... 3=Apr.
  const y = date.getUTCMonth() < 3 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
  return new Date(Date.UTC(y, 3, 1));
}

function seasonLabel_(date) {
  const start = seasonStartUtc_(date);
  const startYear = start.getUTCFullYear();
  return startYear + "-" + String((startYear + 1) % 100).padStart(2, "0");
}

function installArchiveTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "archivePastSeasons") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("archivePastSeasons").timeBased().atHour(1).everyDays(1).create();
}

// ---------- Privacy / access control ----------
// Site mode + access password live in Script Properties (only the script
// owner can read/write). Anyone can flip the toggle from the sheet via
// the 🔒 Privacy menu added by onOpen — that menu only renders for users
// with edit access to the sheet, which is just Simon.

const PROP_SITE_MODE = "siteMode";
const PROP_ACCESS_HASH = "accessPasswordHash";

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🔒 Privacy")
    .addItem("Privat schalten (Passwort setzen)", "menu_setPrivate")
    .addItem("Öffentlich schalten", "menu_setPublic")
    .addItem("Status anzeigen", "menu_showStatus")
    .addToUi();
}

function menu_setPrivate() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "Privat schalten",
    "Neues Zugangs-Passwort eingeben (min 4 Zeichen):",
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const password = String(response.getResponseText() || "").trim();
  if (password.length < 4) {
    ui.alert("Passwort zu kurz (min 4 Zeichen).");
    return;
  }
  const hash = sha256_(password);
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_SITE_MODE, "private");
  props.setProperty(PROP_ACCESS_HASH, hash);
  ui.alert(
    "Site ist jetzt PRIVAT.\n\nZugangs-Passwort:  " + password +
    "\n\nNur an Vertraute weitergeben."
  );
}

function menu_setPublic() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_SITE_MODE, "public");
  props.deleteProperty(PROP_ACCESS_HASH);
  SpreadsheetApp.getUi().alert("Site ist jetzt ÖFFENTLICH (kein Passwort nötig).");
}

function menu_showStatus() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const mode = props[PROP_SITE_MODE] || "public";
  let msg = "Status: " + mode.toUpperCase();
  if (mode === "private") {
    msg += "\nPasswort gesetzt: " + (props[PROP_ACCESS_HASH] ? "✓ ja" : "✗ NEIN (bitte erneut setzen)");
  }
  SpreadsheetApp.getUi().alert(msg);
}

function isPublic_() {
  const mode = PropertiesService.getScriptProperties().getProperty(PROP_SITE_MODE);
  return mode !== "private";
}

function getAccessHash_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_ACCESS_HASH) || "";
}

function checkToken_(token) {
  if (isPublic_()) return true;
  const stored = getAccessHash_();
  if (!stored) return false; // private but no password set — fail closed
  return String(token || "") === stored;
}

function siteStatus_() {
  return { is_public: isPublic_() };
}

function verifyAccess_(params) {
  if (isPublic_()) return { ok: true, token: "" };
  const stored = getAccessHash_();
  if (!stored) return { ok: false, error: "no password set" };
  const token = String(params.token || "");
  if (token && token === stored) return { ok: true, token: stored };
  const password = String(params.password || "");
  if (password && sha256_(password) === stored) return { ok: true, token: stored };
  return { ok: false };
}

function sha256_(input) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    input,
    Utilities.Charset.UTF_8
  );
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += ("0" + (bytes[i] & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

// ---------- Response helpers ----------

function json_(obj /*, statusCode (advisory only) */) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}



// Inlined post data — generated by tools/bake-posts.
// To regenerate: node tools/parse-kml.mjs && node -e ... (see README).
const INLINED_POSTS = [
  {
    "id": "HR-1",
    "name": "Nr. 1 Ackerkante",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.63065,
    "lng": 12.83461
  },
  {
    "id": "HR-2",
    "name": "Nr.2",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62943,
    "lng": 12.83042
  },
  {
    "id": "HR-2A",
    "name": "Nr. 2a",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6293676,
    "lng": 12.8266951
  },
  {
    "id": "HR-3",
    "name": "Nr. 3",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62806,
    "lng": 12.82424
  },
  {
    "id": "HR-3A",
    "name": "Nr. 3a",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62766,
    "lng": 12.82126
  },
  {
    "id": "HR-4",
    "name": "Nr. 4 - Schilfloch",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6273,
    "lng": 12.82624
  },
  {
    "id": "HR-5",
    "name": "Nr. 5",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62716,
    "lng": 12.83145
  },
  {
    "id": "HR-6",
    "name": "Nr. 6",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62691,
    "lng": 12.83396
  },
  {
    "id": "HR-7A",
    "name": "Nr. 7a",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62658,
    "lng": 12.81967
  },
  {
    "id": "HR-8",
    "name": "Nr. 8",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62573,
    "lng": 12.8328
  },
  {
    "id": "HR-9",
    "name": "Nr. 9",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62364,
    "lng": 12.83096
  },
  {
    "id": "HR-10",
    "name": "Nr. 10 - Märchenwald",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.624367,
    "lng": 12.8267271
  },
  {
    "id": "HR-10A",
    "name": "Nr. 10a",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6249,
    "lng": 12.82425
  },
  {
    "id": "HR-12",
    "name": "Nr. 12 - an den Buchen",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62254,
    "lng": 12.82915
  },
  {
    "id": "HR-13",
    "name": "Nr. 13 - Kanzel",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62155,
    "lng": 12.82405
  },
  {
    "id": "HR-13A",
    "name": "Nr. 13a - Wiese",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62057,
    "lng": 12.82695
  },
  {
    "id": "HR-14",
    "name": "Nr. 14 - Kanzel Klein Ivenack",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62075,
    "lng": 12.82244
  },
  {
    "id": "HR-16",
    "name": "Nr. 16",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61949,
    "lng": 12.82477
  },
  {
    "id": "HR-17",
    "name": "Nr. 17",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6208167,
    "lng": 12.8195108
  },
  {
    "id": "HR-18",
    "name": "Nr. 18",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61954,
    "lng": 12.81915
  },
  {
    "id": "HR-19",
    "name": "Nr. 19 - Kanzel Eichwerder Ost",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6176899,
    "lng": 12.8190928
  },
  {
    "id": "HR-20",
    "name": "Nr. 20",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61924,
    "lng": 12.82846
  },
  {
    "id": "HR-21",
    "name": "Nr. 21",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61834,
    "lng": 12.83149
  },
  {
    "id": "HR-22",
    "name": "Nr. 22",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6234511,
    "lng": 12.8222788
  },
  {
    "id": "HR-23",
    "name": "Nr. 23 - Scheidegraben",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61593,
    "lng": 12.82536
  },
  {
    "id": "HR-24",
    "name": "Nr. 24 - Graben",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61585,
    "lng": 12.82332
  },
  {
    "id": "HR-25",
    "name": "Nr. 25",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61323,
    "lng": 12.82363
  },
  {
    "id": "HR-26",
    "name": "Nr. 26",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61151,
    "lng": 12.82398
  },
  {
    "id": "HR-27",
    "name": "Nr. 27 - Lehmweg",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6103,
    "lng": 12.82117
  },
  {
    "id": "HR-28",
    "name": "Nr. 28 - Suhle",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61147,
    "lng": 12.81898
  },
  {
    "id": "HR-29",
    "name": "Nr. 29",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.60993,
    "lng": 12.81588
  },
  {
    "id": "HR-30",
    "name": "Nr. 30 - Lehmweg Ende",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61213,
    "lng": 12.81519
  },
  {
    "id": "HR-32",
    "name": "Nr. 32",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61487,
    "lng": 12.81954
  },
  {
    "id": "HR-33",
    "name": "Nr. 33 - Eichwerderbruch",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6162127,
    "lng": 12.81807
  },
  {
    "id": "HR-34",
    "name": "Nr. 34 - Ahornbock",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61599,
    "lng": 12.81583
  },
  {
    "id": "HR-35",
    "name": "Nr. 35",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61644,
    "lng": 12.8138
  },
  {
    "id": "HR-36",
    "name": "Nr. 36",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61759,
    "lng": 12.813
  },
  {
    "id": "HR-37",
    "name": "Nr. 37 - Kanzel Eichwerder Nord",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6191977,
    "lng": 12.8154821
  },
  {
    "id": "HR-38",
    "name": "Nr. 38 - Kanzel Eierkuhle Süd",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61037,
    "lng": 12.82736
  },
  {
    "id": "HR-39",
    "name": "Nr. 39 - Kanzel Eierkuhle",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61146,
    "lng": 12.8283
  },
  {
    "id": "HR-40",
    "name": "Nr. 40",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61084,
    "lng": 12.83003
  },
  {
    "id": "HR-41",
    "name": "Nr. 41 - Teiche",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61138,
    "lng": 12.8315
  },
  {
    "id": "HR-42",
    "name": "Nr. 42 - Bruch",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61453,
    "lng": 12.82918
  },
  {
    "id": "HR-43",
    "name": "Nr. 43 - Eichenzaum",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61408,
    "lng": 12.83164
  },
  {
    "id": "HR-44",
    "name": "Nr. 44 -Eichenallee",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61668,
    "lng": 12.83097
  },
  {
    "id": "HR-45",
    "name": "Nr. 45 - Eschentot",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61726,
    "lng": 12.83398
  },
  {
    "id": "HR-46",
    "name": "Nr 46 - Kanzel am Graben",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61798,
    "lng": 12.8359
  },
  {
    "id": "HR-47",
    "name": "Nr. 47",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61885,
    "lng": 12.83382
  },
  {
    "id": "HR-48",
    "name": "Nr. 48 - Kanzel Neue Wiese",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61956,
    "lng": 12.83408
  },
  {
    "id": "HR-49",
    "name": "Nr. 49",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62027,
    "lng": 12.83724
  },
  {
    "id": "HR-49A",
    "name": "Nr. 49a - Eichenhügel",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61516,
    "lng": 12.84635
  },
  {
    "id": "HR-50",
    "name": "Nr. 50 Erlenspitze",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62119,
    "lng": 12.83409
  },
  {
    "id": "HR-51",
    "name": "Nr. 51 Erlenbruch",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62161,
    "lng": 12.83827
  },
  {
    "id": "HR-52",
    "name": "Nr. 52 Erlenbruch",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62301,
    "lng": 12.83948
  },
  {
    "id": "HR-53",
    "name": "Nr. 53 Schilfinsel",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.62423,
    "lng": 12.83569
  },
  {
    "id": "HR-54",
    "name": "Nr. 54",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6098,
    "lng": 12.83417
  },
  {
    "id": "HR-55",
    "name": "Nr. 55",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61245,
    "lng": 12.8340772
  },
  {
    "id": "HR-56",
    "name": "Nr. 56 - Holzlager",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61394,
    "lng": 12.83465
  },
  {
    "id": "HR-57",
    "name": "Nr. 57 - Eichenkanzel/ Fichtenriegel",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61508,
    "lng": 12.83382
  },
  {
    "id": "HR-58",
    "name": "Nr. 58 - Kanzel",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61537,
    "lng": 12.83532
  },
  {
    "id": "HR-59",
    "name": "Nr. 59",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6153236,
    "lng": 12.8386548
  },
  {
    "id": "HR-61",
    "name": "Nr. 61",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6182,
    "lng": 12.84565
  },
  {
    "id": "HR-63",
    "name": "Nr. 63 - Eichenrand",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61641,
    "lng": 12.84416
  },
  {
    "id": "HR-66",
    "name": "Nr. 66 - Neue Wiese",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61366,
    "lng": 12.84972
  },
  {
    "id": "HR-68",
    "name": "Nr. 68 - Bruchkante Kiefernhügel",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61321,
    "lng": 12.84419
  },
  {
    "id": "HR-68A",
    "name": "Nr. 68a - Alter Damm",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61385,
    "lng": 12.84599
  },
  {
    "id": "HR-69",
    "name": "Nr. 69 - Sauenkanzel",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61385,
    "lng": 12.84152
  },
  {
    "id": "HR-69A",
    "name": "Nr. 69a - Torfstich",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6151,
    "lng": 12.84203
  },
  {
    "id": "HR-70",
    "name": "Nr. 70 - Kieskuhle",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.6108,
    "lng": 12.84163
  },
  {
    "id": "HR-71",
    "name": "Nr. 71",
    "area": "Hauptrevier",
    "kind": "Nr",
    "lat": 53.61175,
    "lng": 12.83866
  },
  {
    "id": "N-1",
    "name": "Nr. 1",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.64646,
    "lng": 12.87283
  },
  {
    "id": "N-2",
    "name": "Nr. 2 - Sukzession Wiese",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.64707,
    "lng": 12.87115
  },
  {
    "id": "N-3",
    "name": "Nr. 3 - Schweinsrücken",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.64753,
    "lng": 12.87351
  },
  {
    "id": "N-4",
    "name": "Nr. 4",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.64699,
    "lng": 12.87715
  },
  {
    "id": "N-5",
    "name": "Nr. 5 - Käferloch Nord",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.64856,
    "lng": 12.87527
  },
  {
    "id": "N-6",
    "name": "Nr. 6 - Wachturm",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.64922,
    "lng": 12.87402
  },
  {
    "id": "N-6A",
    "name": "Nr. 6a - Erlensuhle",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.64886,
    "lng": 12.87178
  },
  {
    "id": "N-7",
    "name": "Nr. 7",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.6492692,
    "lng": 12.8776542
  },
  {
    "id": "N-8",
    "name": "Nr. 8",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.65129,
    "lng": 12.87746
  },
  {
    "id": "N-9",
    "name": "Nr. 9 - Douglasie",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.65207,
    "lng": 12.88136
  },
  {
    "id": "N-10",
    "name": "Nr. 10 - Mirabelle",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.65309,
    "lng": 12.87829
  },
  {
    "id": "N-11",
    "name": "Nr. 11 -",
    "area": "Nord",
    "kind": "Nr",
    "lat": 53.6528245,
    "lng": 12.8751236
  },
  {
    "id": "NR-4",
    "name": "Nr. 4 - Grenzhügel",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.66305,
    "lng": 12.88705
  },
  {
    "id": "NR-11",
    "name": "Nr. 11 - Birne",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.65547,
    "lng": 12.8818
  },
  {
    "id": "NR-12",
    "name": "Nr. 12",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.65536,
    "lng": 12.87868
  },
  {
    "id": "NR-13",
    "name": "Nr. 13",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.6582167,
    "lng": 12.8781336
  },
  {
    "id": "NR-14",
    "name": "Nr. 14 - Waldhaus Wiese",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.659421,
    "lng": 12.8845359
  },
  {
    "id": "NR-15",
    "name": "Nr. 15 Grenzwiesen",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.6601015,
    "lng": 12.8819424
  },
  {
    "id": "NR-16",
    "name": "Nr. 16",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.66213,
    "lng": 12.8856
  },
  {
    "id": "NR-17",
    "name": "Nr. 17 - Fichte",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.65787,
    "lng": 12.88579
  },
  {
    "id": "NR-18",
    "name": "Nr. 18",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.65694,
    "lng": 12.88424
  },
  {
    "id": "NR-19",
    "name": "Nr. 19",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.6571994,
    "lng": 12.8783697
  },
  {
    "id": "NR-60",
    "name": "Nr. 60",
    "area": "Nordrand",
    "kind": "Nr",
    "lat": 53.6172334,
    "lng": 12.8411497
  },
  {
    "id": "OST-65",
    "name": "Nr.65 - Nordkanzel Neue Wiese",
    "area": "Ost",
    "kind": "Nr",
    "lat": 53.61524,
    "lng": 12.85003
  },
  {
    "id": "OST-DJB63",
    "name": "DJB 63 - Kiefer",
    "area": "Ost",
    "kind": "DJB",
    "lat": 53.61832,
    "lng": 12.85564
  }
];

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const postsSheet = ensureSheet_(ss, SHEETS.posts, POST_HEADER);
  if (postsSheet.getLastRow() > 1) {
    postsSheet.getRange(2, 1, postsSheet.getLastRow() - 1, POST_HEADER.length).clearContent();
  }
  const rows = INLINED_POSTS.map(function (p) { return [p.id, p.name, p.area, p.lat, p.lng]; });
  postsSheet.getRange(2, 1, rows.length, POST_HEADER.length).setValues(rows);
  ensureSheet_(ss, SHEETS.hunters, HUNTER_HEADER);
  ensureSheet_(ss, SHEETS.harvests, HARVEST_HEADER);

  // Catch up on any Kanzeln added in My Maps since the last bake.
  let syncMsg = "";
  try {
    const r = syncPostsFromKml();
    syncMsg = "\nKML-Sync: " + r.added + " neu, " + r.updated + " aktualisiert.";
  } catch (err) {
    syncMsg = "\nKML-Sync hat nicht funktioniert (" + err.message + "), wird stündlich erneut versucht.";
  }

  installArchiveTrigger();
  installPostsSyncTrigger();

  SpreadsheetApp.getUi().alert(
    "Importiert: " + rows.length + " Hochsitze." + syncMsg + "\n" +
    "Trigger installiert: Saison-Rollover (01:00 täglich), KML-Sync (stündlich).\n\n" +
    "Trage jetzt im hunters-Tab Namen ein, dann Bereitstellen → Neue Bereitstellung → Web App."
  );
}

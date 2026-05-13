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
  nachsuchen: "nachsuchen",
  events: "events",
  event_hunters: "event_hunters",
  event_squads: "event_squads",
  address_book: "address_book",
};

const POST_HEADER = ["id", "name", "area", "lat", "lng"];
const HUNTER_HEADER = ["name"];
const HARVEST_HEADER = ["timestamp", "hunter", "post_id", "species", "count", "notes", "wind_speed", "wind_dir", "gender", "age_class"];
const NACHSUCHE_HEADER = ["id", "created_at", "hunter", "stand_nr", "post_id", "summary", "status", "closed_at", "recipient"];
const EVENT_HEADER = ["id", "created_at", "name", "date", "teilgebiet", "rsvp_deadline", "treffpunkt", "treff_time", "start_time", "end_time", "briefing", "organizer", "status", "vet_name", "vet_phone", "coordinator_name", "coordinator_phone", "nachsuchenfuehrer"];
const EVENT_HUNTER_HEADER = ["id", "event_id", "hunter", "email", "token", "status", "role", "dogs", "invited_at", "responded_at"];

// JGHV-anerkannte Jagdhundrassen — single source of truth, baked here so
// the backend can validate what the RSVP page submits. "Sonstige" lets a
// hunter declare a non-listed breed.
const DOG_BREEDS = [
  "Deutsch Drahthaar", "Deutsch Kurzhaar", "Pudelpointer", "Deutsch Stichelhaar",
  "Griffon Korthals", "Drahthaariger Ungarischer Vorstehhund", "Barbet", "Weimaraner",
  "English Pointer", "Kurzhaariger Ungarischer Vorstehhund",
  "Braque de l'Ariège", "Braque du Bourbonnais", "Braque d'Auvergne",
  "Braque Français", "Braque Saint-Germain", "Deutsch Langhaar",
  "Großer Münsterländer", "Kleiner Münsterländer",
  "English Setter", "Gordon Setter", "Irish Red Setter",
  "Epagneul Breton", "Epagneul Français", "Epagneul Bleu de Picardie",
  "Epagneul de Pont-Audemer", "English Cocker Spaniel", "Deutscher Wachtelhund",
  "English Springer Spaniel", "Hannoverscher Schweißhund",
  "Bayerischer Gebirgsschweißhund", "Alpenländische Dachsbracke",
  "Deutscher Jagdterrier", "Foxterrier", "Parson Russell Terrier", "Teckel",
  "Deutsche Bracke", "Westfälische Dachsbracke", "Steirische Rauhhaarbracke",
  "Brandlbracke", "Tiroler Bracke", "Beagle", "English Foxhound",
  "Français tricolore", "Français blanc et noir", "Slovensky Kopov",
  "Curly Coated Retriever", "Golden Retriever", "Flat-coated Retriever",
  "Labrador Retriever", "Chesapeake Bay Retriever",
  "Nova Scotia Duck Tolling Retriever",
  "Russisch-Europäischer Laika", "Ostsibirischer Laika", "Westsibirischer Laika",
  "Black and Tan Coonhound", "Bloodhound",
  "Grand Anglo-Français", "Harrier",
  "Irish Red and White Setter", "Welsh Springer Spaniel",
  "Sonstige",
];
const EVENT_SQUAD_HEADER = ["id", "event_id", "name", "post_id", "post_name", "briefing", "members"];
const ADDRESS_BOOK_HEADER = ["name", "email"];

// ---------- HTTP entrypoints ----------

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    const action = params.action || "bootstrap";
    // Public endpoints — no token needed.
    if (action === "site-status") return json_(siteStatus_());
    if (action === "verify-access") return json_(verifyAccess_(params));
    // RSVP page authenticates via the per-hunter token in the URL.
    if (action === "rsvp-info") return json_(rsvpInfo_(params));
    // Everything else requires a valid token if the site is private.
    if (!checkToken_(params.token)) {
      return json_({ error: "private", code: "AUTH_REQUIRED" });
    }
    if (action === "bootstrap") return json_(bootstrap_());
    if (action === "aggregates") return json_(aggregates_(params));
    if (action === "sync") return json_(syncPostsFromKml());
    if (action === "history") return json_(history_(params));
    if (action === "strecke") return json_(strecke_(params));
    if (action === "nachsuche-list") return json_(nachsucheList_());
    if (action === "events-list") return json_(eventsList_());
    if (action === "event-detail") return json_(eventDetail_(params));
    if (action === "address-book") return json_(addressBookList_());
    return json_({ error: "unknown action" }, 400);
  } catch (err) {
    return json_({ error: String(err && err.message || err) }, 500);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || "{}");
    const action = body.action || "harvest";
    // RSVP responses authenticate via the per-hunter token in the body,
    // not the privacy gate token — so the link works without the password.
    if (action === "rsvp-respond") {
      const r = rsvpRespond_(body);
      return json_(r, r.error ? 400 : 200);
    }
    if (!checkToken_(body.token)) {
      return json_({ error: "private", code: "AUTH_REQUIRED" });
    }
    if (action === "nachsuche-create") {
      const r = nachsucheCreate_(body);
      return json_(r, r.error ? 400 : 200);
    }
    if (action === "nachsuche-close") {
      const r = nachsucheClose_(body);
      return json_(r, r.error ? 400 : 200);
    }
    if (action === "event-create") {
      const r = eventCreate_(body);
      return json_(r, r.error ? 400 : 200);
    }
    if (action === "event-hunter-add") {
      const r = eventHunterAdd_(body);
      return json_(r, r.error ? 400 : 200);
    }
    if (action === "event-hunter-remove") {
      const r = eventHunterRemove_(body);
      return json_(r, r.error ? 400 : 200);
    }
    if (action === "event-invites-send") {
      const r = eventInvitesSend_(body);
      return json_(r, r.error ? 400 : 200);
    }
    if (action === "event-squad-save") {
      const r = eventSquadSave_(body);
      return json_(r, r.error ? 400 : 200);
    }
    if (action === "event-squad-delete") {
      const r = eventSquadDelete_(body);
      return json_(r, r.error ? 400 : 200);
    }
    // default — log a harvest
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
  const buckets = {}; // species → { count, by_gender: { m: {count,age{...}}, w, unknown } }
  function emptyAge() {
    return { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, unknown: 0 };
  }
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ts = new Date(r.timestamp);
    if (from && ts < from) continue;
    if (to && ts > to) continue;
    const sp = String(r.species || "").trim();
    if (!sp) continue;
    const n = Number(r.count) || 0;
    if (!n) continue;
    if (!buckets[sp]) {
      buckets[sp] = {
        count: 0,
        by_gender: {
          m: { count: 0, age: emptyAge() },
          w: { count: 0, age: emptyAge() },
          unknown: { count: 0, age: emptyAge() },
        },
      };
    }
    const b = buckets[sp];
    b.count += n;
    total += n;
    const g = safeStr_(r.gender).toLowerCase();
    const gKey = g === "m" ? "m" : g === "w" ? "w" : "unknown";
    b.by_gender[gKey].count += n;
    const a = safeStr_(r.age_class);
    const aKey = (a === "0" || a === "1" || a === "2" || a === "3" || a === "4") ? a : "unknown";
    b.by_gender[gKey].age[aKey] += n;
  }
  const by_species = Object.keys(buckets)
    .map(function (sp) {
      const b = buckets[sp];
      return { species: sp, count: b.count, by_gender: b.by_gender };
    })
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
        gender: safeStr_(r.gender),
        age_class: safeStr_(r.age_class),
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

  // Optional descriptors. Empty string when unset; validated to known
  // values otherwise so the stats tab doesn't get junk data.
  let gender = String(body.gender || "").trim().toLowerCase();
  if (gender && gender !== "m" && gender !== "w") gender = "";
  let ageClass = String(body.age_class || "").trim();
  if (ageClass && !/^[0-4]$/.test(ageClass)) ageClass = "";

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
    gender: gender,
    age_class: ageClass,
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

// Inverse map (area name → ID prefix) for coord-based classification.
const AREA_PREFIX_BY_AREA = {
  "Hauptrevier": "HR",
  "Ost":         "OST",
  "Nord":        "N",
  "Nordrand":    "NR",
};

// Geographic bounding boxes per revier sub-area. A placemark is classified
// by whichever box it falls into (boxes are non-overlapping). Empty result
// = the marker isn't inside any known revier and gets ignored.
//
// Splits derived from the actual marker coords:
//   - HR's eastern edge at lng 12.84972; Ost's western edge at lng 12.85003
//     → boundary at 12.850 (HR strictly < 12.850, Ost ≥ 12.850).
//   - HR's northern edge ≈ 53.631; Nord's southern edge ≈ 53.646 → safe gap.
//   - Nord top ≈ 53.654; Nordrand bottom ≈ 53.655 → boundary at 53.654.
function classifyByCoords_(lat, lng) {
  if (lat >= 53.605 && lat <= 53.640 && lng >= 12.810 && lng <  12.850) return "Hauptrevier";
  if (lat >= 53.610 && lat <= 53.625 && lng >= 12.850 && lng <= 12.860) return "Ost";
  if (lat >  53.640 && lat <= 53.654 && lng >= 12.860 && lng <= 12.890) return "Nord";
  if (lat >  53.654 && lat <= 53.670 && lng >= 12.870 && lng <= 12.895) return "Nordrand";
  return null;
}

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
  // Walk every Point placemark in the whole KML — folder membership is
  // a hint we ignore. The placemark's coordinates decide which revier
  // it belongs to (classifyByCoords_), so a marker accidentally added
  // to the wrong My Maps layer still gets the right area + ID prefix.
  const placemarks = parseKmlPointPlacemarks_(kml);
  const out = [];
  for (let j = 0; j < placemarks.length; j++) {
    const pm = placemarks[j];
    if (!isHuntingPostName_(pm.name)) continue;
    const num = postNumber_(pm.name);
    if (!num) continue;
    const area = classifyByCoords_(pm.lat, pm.lng);
    if (!area) continue;
    const prefix = AREA_PREFIX_BY_AREA[area];
    if (!prefix) continue;
    const isDjb = /^DJB/i.test(pm.name);
    const idCore = (isDjb ? "DJB" : "") + num;
    out.push({
      id: prefix + "-" + idCore.toUpperCase(),
      name: pm.name,
      area: area,
      lat: pm.lat,
      lng: pm.lng,
    });
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

// ---------- Auto-statistics ----------
// Reads all harvest rows and rebuilds a 'stats' tab with three summary
// tables + bar charts: by species, by gender, by age class. Wipes and
// re-creates the tab on each call so it's always fresh.

function rebuildStats() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const harvests = readHarvests_();

  const bySpecies = {};
  const byGender = { m: 0, w: 0, "?": 0 };
  const byAge = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "?": 0 };
  let total = 0;
  let withGender = 0;
  let withAge = 0;

  for (let i = 0; i < harvests.length; i++) {
    const r = harvests[i];
    const count = Number(r.count) || 0;
    if (!count) continue;
    const sp = String(r.species || "?").trim() || "?";
    const g = safeStr_(r.gender);
    const a = safeStr_(r.age_class);
    bySpecies[sp] = (bySpecies[sp] || 0) + count;
    if (g === "m" || g === "w") {
      byGender[g] += count;
      withGender += count;
    } else {
      byGender["?"] += count;
    }
    if (/^[0-4]$/.test(a)) {
      byAge[a] += count;
      withAge += count;
    } else {
      byAge["?"] += count;
    }
    total += count;
  }

  // Wipe and rebuild the stats tab.
  let sheet = ss.getSheetByName("stats");
  if (sheet) {
    const charts = sheet.getCharts();
    for (let c = 0; c < charts.length; c++) sheet.removeChart(charts[c]);
    sheet.clear();
  } else {
    sheet = ss.insertSheet("stats");
  }

  sheet.getRange("A1").setValue("Statistik — aktualisiert " + new Date().toLocaleString("de-DE"))
    .setFontWeight("bold");

  let row = 3;
  row = writeStatsBlock_(sheet, row, "Strecke nach Wildart",
    Object.keys(bySpecies).sort(function (a, b) { return bySpecies[b] - bySpecies[a]; })
      .map(function (k) { return [k, bySpecies[k]]; }));

  row = writeStatsBlock_(sheet, row, "Strecke nach Geschlecht", [
    ["männlich (♂)", byGender.m],
    ["weiblich (♀)", byGender.w],
    ["unbekannt", byGender["?"]],
  ].filter(function (e) { return e[1] > 0; }));

  row = writeStatsBlock_(sheet, row, "Strecke nach Altersklasse", [
    ["AK 0", byAge["0"]],
    ["AK 1", byAge["1"]],
    ["AK 2", byAge["2"]],
    ["AK 3", byAge["3"]],
    ["AK 4", byAge["4"]],
    ["unbekannt", byAge["?"]],
  ].filter(function (e) { return e[1] > 0; }));

  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 90);

  return { total: total, species: Object.keys(bySpecies).length, withGender: withGender, withAge: withAge };
}

function writeStatsBlock_(sheet, startRow, title, rows) {
  if (!rows.length) return startRow;
  sheet.getRange(startRow, 1).setValue(title).setFontWeight("bold").setFontSize(12);
  const headerRow = startRow + 1;
  sheet.getRange(headerRow, 1, 1, 2).setValues([["Kategorie", "Anzahl"]]).setFontWeight("bold");
  const dataStart = headerRow + 1;
  sheet.getRange(dataStart, 1, rows.length, 2).setValues(rows);
  const dataEnd = dataStart + rows.length - 1;

  const chart = sheet.newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(sheet.getRange(headerRow, 1, rows.length + 1, 2))
    .setPosition(dataEnd + 2, 1, 0, 0)
    .setOption("title", title)
    .setOption("legend", { position: "none" })
    .setOption("hAxis", { title: "Anzahl" })
    .setOption("colors", ["#1f3a1f"])
    .build();
  sheet.insertChart(chart);

  // Leave room for chart (~16 rows) + spacer
  return dataEnd + 18;
}

function installStatsTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "rebuildStats") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // 02:00 daily — after the season-archive trigger at 01:00.
  ScriptApp.newTrigger("rebuildStats").timeBased().atHour(2).everyDays(1).create();
}

// ---------- Nachsuche (pending wounded-game tracking) ----------
// An Anschuss-Protokoll submitted from the app creates an open Nachsuche
// record. The frontend shows a flashing skull marker at the associated
// Stand until someone marks it closed. If a recipient email + PDF were
// supplied, the PDF is mailed from the script owner's Gmail.

function nachsucheList_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEETS.nachsuchen, NACHSUCHE_HEADER);
  const rows = readSheet_(SHEETS.nachsuchen, NACHSUCHE_HEADER);
  const posts = readPosts_();
  const postMap = {};
  for (let i = 0; i < posts.length; i++) postMap[posts[i].id] = posts[i];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r.status || "open").toLowerCase() === "closed") continue;
    const post = postMap[String(r.post_id || "")];
    if (!post || !Number.isFinite(post.lat) || !Number.isFinite(post.lng)) continue;
    const ts = new Date(r.created_at);
    out.push({
      id: String(r.id),
      created_at: isNaN(ts) ? null : ts.toISOString(),
      hunter: String(r.hunter || ""),
      stand_nr: String(r.stand_nr || ""),
      post_id: String(r.post_id || ""),
      post_name: String(post.name || ""),
      summary: String(r.summary || ""),
      lat: post.lat,
      lng: post.lng,
    });
  }
  return out;
}

// Map a "Stand-Nr." string ("13", "Nr. 13", "HR-13", "13a", "DJB 63")
// to a posts-tab row.
function resolveStandToPost_(standNr) {
  const s = String(standNr || "").trim();
  if (!s) return null;
  const posts = readPosts_();
  for (let i = 0; i < posts.length; i++) {
    if (posts[i].id.toLowerCase() === s.toLowerCase()) return posts[i];
  }
  const numMatch = s.match(/(\d+[a-z]?)/i);
  if (numMatch) {
    const num = numMatch[1].toLowerCase();
    for (let i = 0; i < posts.length; i++) {
      const p = posts[i];
      const nameNum = String(p.name).match(/^(?:Nr\.?|DJB)\s*(\d+[a-z]?)/i);
      if (nameNum && nameNum[1].toLowerCase() === num) return p;
      const idTail = String(p.id).split("-").pop().toLowerCase();
      if (idTail === num) return p;
    }
  }
  return null;
}

function nachsucheCreate_(body) {
  const hunter = String(body.hunter || "").trim() || "?";
  const summary = String(body.summary || "").trim().slice(0, 240);
  const recipient = String(body.recipient || "").trim();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Resolve where the Nachsuche is. Three inputs, in priority order:
  //   1. post_id     — a Kanzel picked from the dropdown (exact id)
  //   2. free_location {lat,lng,label,kind} — Klettersitz/Pirsch; we
  //      materialise it as a posts row exactly like logHarvest_ does
  //   3. stand_nr    — legacy free-text Stand number, fuzzy-matched
  let post = null;
  let postId = String(body.post_id || "").trim();
  if (postId) {
    post = readPosts_().find(function (p) { return p.id === postId; }) || null;
  }
  if (!post && body.free_location) {
    const free = body.free_location;
    const lat = Number(free.lat);
    const lng = Number(free.lng);
    if (Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
        Number.isFinite(lng) && lng >= -180 && lng <= 180) {
      const rawLabel = String(free.label || "").trim().slice(0, 40);
      const labelOk = !rawLabel || /^[\p{L}\p{N}][\p{L}\p{N}\s.\-_/'"]{0,39}$/u.test(rawLabel);
      const KIND = {
        klettersitz: { area: "Klettersitz", prefix: "KS-" },
        pirsch:      { area: "Pirsch",      prefix: "P-"  },
      };
      const cfg = KIND[String(free.kind || "klettersitz").toLowerCase()] || KIND.klettersitz;
      const niceLabel = (labelOk && rawLabel) || (cfg.area + " " + lat.toFixed(4) + ", " + lng.toFixed(4));
      postId = cfg.prefix + Date.now().toString(36).toUpperCase();
      ensureSheet_(ss, SHEETS.posts, POST_HEADER).appendRow([postId, niceLabel, cfg.area, lat, lng]);
      post = { id: postId, name: niceLabel, area: cfg.area, lat: lat, lng: lng };
    }
  }
  if (!post && body.stand_nr) {
    post = resolveStandToPost_(String(body.stand_nr));
    if (post) postId = post.id;
  }
  const standNr = post ? String(post.name) : String(body.stand_nr || "").trim();

  const sheet = ensureSheet_(ss, SHEETS.nachsuchen, NACHSUCHE_HEADER);
  const id = "NS-" + Date.now().toString(36).toUpperCase();
  appendByName_(sheet, {
    id: id,
    created_at: new Date().toISOString(),
    hunter: hunter,
    stand_nr: standNr,
    post_id: post ? post.id : "",
    summary: summary,
    status: "open",
    closed_at: "",
    recipient: recipient,
  });

  let emailed = false;
  let emailError = "";
  if (recipient && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient) && body.pdf_base64) {
    try {
      const bytes = Utilities.base64Decode(body.pdf_base64);
      const blob = Utilities.newBlob(bytes, "application/pdf", "anschuss-protokoll.pdf");
      MailApp.sendEmail({
        to: recipient,
        subject: "Anschuss-Protokoll — Nachsuche" + (standNr ? " (Stand " + standNr + ")" : ""),
        body: "Hallo,\n\nanbei das Anschuss-Protokoll von " + hunter + "." +
          (summary ? "\n\n" + summary : "") +
          "\n\n— automatisch versendet aus PREYE (Peenwerder Jagd)",
        attachments: [blob],
      });
      emailed = true;
    } catch (err) {
      emailError = String(err && err.message || err);
    }
  }
  return { ok: true, id: id, post_id: post ? post.id : "", post_found: !!post, emailed: emailed, email_error: emailError };
}

function nachsucheClose_(body) {
  const id = String(body.id || "").trim();
  if (!id) return { error: "id required" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.nachsuchen, NACHSUCHE_HEADER);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: "not found" };
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (s) { return String(s).trim(); });
  const idCol = header.indexOf("id") + 1;
  const statusCol = header.indexOf("status") + 1;
  const closedCol = header.indexOf("closed_at") + 1;
  if (!idCol || !statusCol) return { error: "schema" };
  const ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === id) {
      sheet.getRange(i + 2, statusCol).setValue("closed");
      if (closedCol) sheet.getRange(i + 2, closedCol).setValue(new Date().toISOString());
      return { ok: true };
    }
  }
  return { error: "not found" };
}

// ---------- Privacy / access control ----------
// Site mode + access password live in Script Properties (only the script
// owner can read/write). Anyone can flip the toggle from the sheet via
// the 🔒 Privacy menu added by onOpen — that menu only renders for users
// with edit access to the sheet, which is just Simon.

const PROP_SITE_MODE = "siteMode";
const PROP_ACCESS_HASH = "accessPasswordHash";

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("🔒 Privacy")
    .addItem("Privat schalten (Passwort setzen)", "menu_setPrivate")
    .addItem("Öffentlich schalten", "menu_setPublic")
    .addItem("Status anzeigen", "menu_showStatus")
    .addToUi();
  ui.createMenu("📊 Statistik")
    .addItem("Aktualisieren", "menu_rebuildStats")
    .addItem("Posten neu klassifizieren", "menu_reclassifyPosts")
    .addItem("Verlorene Klettersitz/Pirsch-Posten anzeigen", "menu_listLostFreePosts")
    .addToUi();
  ui.createMenu("📧 E-Mail")
    .addItem("Test-E-Mail an mich senden", "menu_testEmail")
    .addToUi();
}

// One-time check that the "send email as you" permission is granted and
// delivery works. Run this from the menu (or the Run ▶ button) — it will
// trigger the OAuth consent screen on first use, which is exactly the grant
// the Anschuss-Protokoll's PDF mailer needs.
function menu_testEmail() {
  const ui = SpreadsheetApp.getUi();
  const me = Session.getActiveUser().getEmail();
  try {
    MailApp.sendEmail(me, "PREYE — Test", "E-Mail-Versand funktioniert. " +
      "Verbleibendes Tageskontingent: " + MailApp.getRemainingDailyQuota());
    ui.alert("Gesendet an " + me + ".\nVerbleibendes Kontingent heute: " + MailApp.getRemainingDailyQuota());
  } catch (err) {
    ui.alert("Fehlgeschlagen: " + (err && err.message || err));
  }
}

// Walk every row in the posts sheet and rename any whose ID prefix /
// area no longer match where the marker physically sits. Runs once
// after the bounding-box classifier was tightened so existing wrong
// entries get fixed in place — IDs and area are updated, harvest rows
// referring to the old ID get rewritten to the new ID, and ID
// collisions (where the correct row already exists) trigger a row
// deletion of the orphan instead of a rename.
function menu_reclassifyPosts() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const postsSheet = ensureSheet_(ss, SHEETS.posts, POST_HEADER);
  const harvestsSheet = ensureSheet_(ss, SHEETS.harvests, HARVEST_HEADER);
  const lastRow = postsSheet.getLastRow();
  if (lastRow < 2) {
    ui.alert("Keine Posten zum Reklassifizieren.");
    return;
  }
  const data = postsSheet.getRange(2, 1, lastRow - 1, POST_HEADER.length).getValues();

  // Build a set of all existing post IDs so we can detect collisions.
  const existingIds = {};
  for (let i = 0; i < data.length; i++) existingIds[String(data[i][0]).trim()] = i;

  const renames = []; // {rowIdx, oldId, newId, newArea}
  const drops = [];   // rowIdx (1-based) — orphans where the correct row already exists
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const id = String(row[0]).trim();
    const lat = Number(row[3]);
    const lng = Number(row[4]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // User-created free posts (Klettersitz / Pirsch) shouldn't be re-prefixed.
    if (id.indexOf("KS-") === 0 || id.indexOf("P-") === 0 || id.indexOf("FREE-") === 0) continue;
    const correctArea = classifyByCoords_(lat, lng);
    if (!correctArea) continue;
    const correctPrefix = AREA_PREFIX_BY_AREA[correctArea];
    const dashIdx = id.indexOf("-");
    if (dashIdx <= 0) continue;
    const currentPrefix = id.substring(0, dashIdx);
    if (currentPrefix === correctPrefix) continue;
    const idCore = id.substring(dashIdx + 1);
    const newId = correctPrefix + "-" + idCore;
    if (existingIds[newId] !== undefined && existingIds[newId] !== i) {
      // Correct row already exists → orphan, drop this one.
      drops.push(i + 2);
    } else {
      renames.push({ rowIdx: i + 2, oldId: id, newId: newId, newArea: correctArea });
      existingIds[newId] = i;
      delete existingIds[id];
    }
  }

  // Apply renames: update id (col 1) and area (col 3) in-place; rewrite
  // any harvest row referring to oldId.
  const harvestHeader = harvestsSheet.getLastColumn() > 0
    ? harvestsSheet.getRange(1, 1, 1, harvestsSheet.getLastColumn()).getValues()[0]
    : [];
  const postIdCol = harvestHeader.indexOf("post_id") + 1; // 1-based, 0 if not found
  const harvestLastRow = harvestsSheet.getLastRow();
  let harvestVals = null;
  if (postIdCol > 0 && harvestLastRow > 1) {
    harvestVals = harvestsSheet.getRange(2, postIdCol, harvestLastRow - 1, 1).getValues();
  }
  let harvestRefsRewritten = 0;
  for (let r = 0; r < renames.length; r++) {
    const u = renames[r];
    postsSheet.getRange(u.rowIdx, 1).setValue(u.newId);
    postsSheet.getRange(u.rowIdx, 3).setValue(u.newArea);
    if (harvestVals) {
      for (let j = 0; j < harvestVals.length; j++) {
        if (String(harvestVals[j][0]).trim() === u.oldId) {
          harvestVals[j][0] = u.newId;
          harvestRefsRewritten++;
        }
      }
    }
  }
  if (harvestVals && harvestRefsRewritten > 0) {
    harvestsSheet.getRange(2, postIdCol, harvestVals.length, 1).setValues(harvestVals);
  }

  // Apply drops: delete rows from bottom up so the indices stay valid.
  drops.sort(function (a, b) { return b - a; });
  for (let d = 0; d < drops.length; d++) {
    postsSheet.deleteRow(drops[d]);
  }

  ui.alert(
    "Posten reklassifiziert.\n\n" +
    "Umbenannt: " + renames.length + "\n" +
    "Verworfene Duplikate: " + drops.length + "\n" +
    "Harvest-Zeilen aktualisiert: " + harvestRefsRewritten
  );
}

// Lists Klettersitz/Pirsch/FREE post IDs that are referenced by harvest
// rows but no longer have a matching row in the posts tab — i.e. lost.
// Coords aren't recoverable (harvests don't store them), but knowing
// which IDs and how many harvests each had helps Simon manually re-add
// them with the same ID so the orphan history relinks automatically.
function menu_listLostFreePosts() {
  const harvests = readHarvests_();
  const posts = readPosts_();
  const known = {};
  for (let i = 0; i < posts.length; i++) known[posts[i].id] = true;

  const orphans = {};
  for (let i = 0; i < harvests.length; i++) {
    const h = harvests[i];
    const pid = String(h.post_id || "").trim();
    if (!pid || known[pid]) continue;
    if (pid.indexOf("KS-") !== 0 && pid.indexOf("P-") !== 0 && pid.indexOf("FREE-") !== 0) continue;
    if (!orphans[pid]) orphans[pid] = { count: 0, latest: "", entries: 0 };
    orphans[pid].count += Number(h.count) || 0;
    orphans[pid].entries++;
    const ts = String(h.timestamp || "");
    if (ts > orphans[pid].latest) orphans[pid].latest = ts;
  }

  const ids = Object.keys(orphans);
  if (ids.length === 0) {
    SpreadsheetApp.getUi().alert("Keine verlorenen Klettersitz- oder Pirsch-Posten.");
    return;
  }
  let msg = "Diese Klettersitz/Pirsch-Posten fehlen im 'posts' Tab, " +
    "obwohl noch Strecken-Einträge auf sie zeigen:\n\n";
  ids.sort();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const o = orphans[id];
    msg += "• " + id + " — " + o.count + " Stück (" + o.entries + " Einträge), zuletzt " +
      (o.latest ? o.latest.slice(0, 10) : "—") + "\n";
  }
  msg += "\nWiederherstellen: im 'posts' Tab eine neue Zeile mit dieser ID, " +
    "Bereich = 'Klettersitz' oder 'Pirsch', und den Koordinaten anlegen.";
  SpreadsheetApp.getUi().alert(msg);
}

function menu_rebuildStats() {
  const r = rebuildStats();
  SpreadsheetApp.getUi().alert(
    "Statistik aktualisiert.\n\n" +
    "Gesamt-Strecke: " + r.total + " Stück\n" +
    "Wildarten: " + r.species + " · Geschlecht erfasst: " + r.withGender + " · Altersklasse erfasst: " + r.withAge
  );
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

// Convert a sheet cell value to a trimmed string without the falsy-trap
// of `value || ""` — which would turn the number 0 (e.g. age_class for
// AK 0) into the empty string and silently drop it from stats.
function safeStr_(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// ---------- Drückjagd / event organisation ----------
// One driven-hunt day = one row in `events`. The roster lives in
// `event_hunters` (one row per invited hunter, with a per-row token used
// as the magic-link auth for the RSVP page). Optional squads live in
// `event_squads`. `address_book` stores reusable name+email contacts so
// you don't retype them across events.

function eventsList_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEETS.events, EVENT_HEADER);
  ensureSheet_(ss, SHEETS.event_hunters, EVENT_HUNTER_HEADER);
  const events = readSheet_(SHEETS.events, EVENT_HEADER);
  const hunters = readSheet_(SHEETS.event_hunters, EVENT_HUNTER_HEADER);
  return events.map(function (ev) {
    const stats = { invited: 0, accepted: 0, declined: 0, pending: 0 };
    for (let i = 0; i < hunters.length; i++) {
      if (String(hunters[i].event_id) !== String(ev.id)) continue;
      stats.invited++;
      const s = String(hunters[i].status || "").toLowerCase();
      if (s === "accepted") stats.accepted++;
      else if (s === "declined") stats.declined++;
      else stats.pending++;
    }
    return {
      id: String(ev.id),
      name: String(ev.name || ""),
      date: String(ev.date || ""),
      teilgebiet: String(ev.teilgebiet || ""),
      rsvp_deadline: String(ev.rsvp_deadline || ""),
      treffpunkt: String(ev.treffpunkt || ""),
      treff_time: String(ev.treff_time || ""),
      start_time: String(ev.start_time || ""),
      end_time: String(ev.end_time || ""),
      organizer: String(ev.organizer || ""),
      status: String(ev.status || ""),
      stats: stats,
    };
  }).sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
}

function eventDetail_(params) {
  const id = String((params && params.id) || "").trim();
  if (!id) return { error: "id required" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEETS.events, EVENT_HEADER);
  ensureSheet_(ss, SHEETS.event_hunters, EVENT_HUNTER_HEADER);
  ensureSheet_(ss, SHEETS.event_squads, EVENT_SQUAD_HEADER);
  const ev = readSheet_(SHEETS.events, EVENT_HEADER)
    .find(function (e) { return String(e.id) === id; });
  if (!ev) return { error: "not found" };
  const hunters = readSheet_(SHEETS.event_hunters, EVENT_HUNTER_HEADER)
    .filter(function (h) { return String(h.event_id) === id; })
    .map(function (h) {
      let dogs = [];
      try { dogs = JSON.parse(String(h.dogs || "[]")); } catch (e) {}
      return {
        id: String(h.id),
        hunter: String(h.hunter || ""),
        email: String(h.email || ""),
        status: String(h.status || "pending"),
        role: String(h.role || ""),
        dogs: Array.isArray(dogs) ? dogs : [],
        invited_at: String(h.invited_at || ""),
        responded_at: String(h.responded_at || ""),
      };
    });
  const squads = readSheet_(SHEETS.event_squads, EVENT_SQUAD_HEADER)
    .filter(function (s) { return String(s.event_id) === id; })
    .map(function (s) {
      let members = [];
      try { members = JSON.parse(String(s.members || "[]")); } catch (e) {}
      return {
        id: String(s.id),
        name: String(s.name || ""),
        post_id: String(s.post_id || ""),
        post_name: String(s.post_name || ""),
        briefing: String(s.briefing || ""),
        members: Array.isArray(members) ? members : [],
      };
    });
  let nsfList = [];
  try { nsfList = JSON.parse(String(ev.nachsuchenfuehrer || "[]")); } catch (e) {}
  return {
    event: {
      id: String(ev.id),
      name: String(ev.name || ""),
      date: String(ev.date || ""),
      teilgebiet: String(ev.teilgebiet || ""),
      rsvp_deadline: String(ev.rsvp_deadline || ""),
      treffpunkt: String(ev.treffpunkt || ""),
      treff_time: String(ev.treff_time || ""),
      start_time: String(ev.start_time || ""),
      end_time: String(ev.end_time || ""),
      briefing: String(ev.briefing || ""),
      organizer: String(ev.organizer || ""),
      status: String(ev.status || ""),
      vet_name: String(ev.vet_name || ""),
      vet_phone: String(ev.vet_phone || ""),
      coordinator_name: String(ev.coordinator_name || ""),
      coordinator_phone: String(ev.coordinator_phone || ""),
      nachsuchenfuehrer: Array.isArray(nsfList) ? nsfList : [],
    },
    hunters: hunters,
    squads: squads,
  };
}

function eventCreate_(body) {
  const name = String(body.name || "").trim();
  if (!name) return { error: "name required" };
  const date = String(body.date || "").trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "valid date (YYYY-MM-DD) required" };
  const id = "EVT-" + Date.now().toString(36).toUpperCase();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.events, EVENT_HEADER);
  // Nachsuchenführer is a list of {name, phone} — store as JSON so the row
  // stays one cell wide even when the organizer adds many.
  let nsfList = [];
  if (Array.isArray(body.nachsuchenfuehrer)) {
    nsfList = body.nachsuchenfuehrer
      .map(function (p) {
        return { name: String(p && p.name || "").trim(), phone: String(p && p.phone || "").trim() };
      })
      .filter(function (p) { return p.name || p.phone; })
      .slice(0, 20);
  }
  appendByName_(sheet, {
    id: id,
    created_at: new Date().toISOString(),
    name: name,
    date: date,
    teilgebiet: String(body.teilgebiet || "").trim(),
    rsvp_deadline: String(body.rsvp_deadline || "").trim(),
    treffpunkt: String(body.treffpunkt || "").trim(),
    treff_time: String(body.treff_time || "").trim(),
    start_time: String(body.start_time || "").trim(),
    end_time: String(body.end_time || "").trim(),
    briefing: String(body.briefing || "").trim(),
    organizer: String(body.organizer || "").trim(),
    status: "draft",
    vet_name: String(body.vet_name || "").trim(),
    vet_phone: String(body.vet_phone || "").trim(),
    coordinator_name: String(body.coordinator_name || "").trim(),
    coordinator_phone: String(body.coordinator_phone || "").trim(),
    nachsuchenfuehrer: JSON.stringify(nsfList),
  });
  return { ok: true, id: id };
}

function eventHunterAdd_(body) {
  const eventId = String(body.event_id || "").trim();
  const hunter = String(body.hunter || "").trim();
  const email = String(body.email || "").trim();
  if (!eventId) return { error: "event_id required" };
  if (!hunter) return { error: "hunter required" };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "invalid email" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.event_hunters, EVENT_HUNTER_HEADER);
  // Reject duplicate (same event, same hunter name).
  const existing = readSheet_(SHEETS.event_hunters, EVENT_HUNTER_HEADER)
    .find(function (h) {
      return String(h.event_id) === eventId &&
             String(h.hunter).toLowerCase() === hunter.toLowerCase();
    });
  if (existing) return { error: "already on the roster" };
  const id = "EH-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
  appendByName_(sheet, {
    id: id,
    event_id: eventId,
    hunter: hunter,
    email: email,
    token: randomToken_(),
    status: "pending",
    invited_at: "",
    responded_at: "",
  });
  // Upsert into the address book so future events autocomplete it.
  if (email) addressBookUpsert_(hunter, email);
  return { ok: true, id: id };
}

function eventHunterRemove_(body) {
  const id = String(body.id || "").trim();
  if (!id) return { error: "id required" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.event_hunters, EVENT_HUNTER_HEADER);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: "not found" };
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === id) {
      sheet.deleteRow(i + 2);
      return { ok: true };
    }
  }
  return { error: "not found" };
}

function eventInvitesSend_(body) {
  const eventId = String(body.event_id || "").trim();
  if (!eventId) return { error: "event_id required" };
  const onlyUnsent = body.only_unsent !== false; // default true
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const eventsSheet = ensureSheet_(ss, SHEETS.events, EVENT_HEADER);
  const huntersSheet = ensureSheet_(ss, SHEETS.event_hunters, EVENT_HUNTER_HEADER);
  const ev = readSheet_(SHEETS.events, EVENT_HEADER)
    .find(function (e) { return String(e.id) === eventId; });
  if (!ev) return { error: "event not found" };
  const baseUrl = String(body.base_url || "").trim();
  if (!baseUrl) return { error: "base_url required (the site origin so the magic-link works)" };

  const rows = huntersSheet.getRange(2, 1, Math.max(huntersSheet.getLastRow() - 1, 0), EVENT_HUNTER_HEADER.length).getValues();
  const headers = huntersSheet.getRange(1, 1, 1, EVENT_HUNTER_HEADER.length).getValues()[0]
    .map(function (s) { return String(s).trim(); });
  const colEventId = headers.indexOf("event_id");
  const colEmail = headers.indexOf("email");
  const colHunter = headers.indexOf("hunter");
  const colToken = headers.indexOf("token");
  const colStatus = headers.indexOf("status");
  const colInvitedAt = headers.indexOf("invited_at");

  let sent = 0, skipped = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][colEventId]) !== eventId) continue;
    const email = String(rows[i][colEmail] || "").trim();
    if (!email) { skipped++; continue; }
    const invitedAt = String(rows[i][colInvitedAt] || "").trim();
    if (onlyUnsent && invitedAt) { skipped++; continue; }
    const hunter = String(rows[i][colHunter] || "");
    const token = String(rows[i][colToken] || "") || randomToken_();
    if (!String(rows[i][colToken] || "").trim()) {
      huntersSheet.getRange(i + 2, colToken + 1).setValue(token);
    }
    const link = baseUrl.replace(/\/+$/, "") + "/rsvp.html?t=" + encodeURIComponent(token);
    const subject = "Einladung Drückjagd: " + String(ev.name || "");
    const body = inviteEmailBody_(ev, hunter, link);
    try {
      MailApp.sendEmail({ to: email, subject: subject, body: body });
      huntersSheet.getRange(i + 2, colInvitedAt + 1).setValue(new Date().toISOString());
      if (String(rows[i][colStatus] || "").toLowerCase() !== "accepted" &&
          String(rows[i][colStatus] || "").toLowerCase() !== "declined") {
        huntersSheet.getRange(i + 2, colStatus + 1).setValue("invited");
      }
      sent++;
    } catch (err) {
      errors.push({ hunter: hunter, error: String(err && err.message || err) });
    }
  }
  // Flip the event status to "open" once at least one invitation has gone out.
  if (sent > 0 && String(ev.status || "") === "draft") {
    const evRows = eventsSheet.getRange(2, 1, eventsSheet.getLastRow() - 1, EVENT_HEADER.length).getValues();
    const evHeaders = eventsSheet.getRange(1, 1, 1, EVENT_HEADER.length).getValues()[0]
      .map(function (s) { return String(s).trim(); });
    const idCol = evHeaders.indexOf("id");
    const statusCol = evHeaders.indexOf("status");
    for (let i = 0; i < evRows.length; i++) {
      if (String(evRows[i][idCol]) === eventId) {
        eventsSheet.getRange(i + 2, statusCol + 1).setValue("open");
        break;
      }
    }
  }
  return { ok: true, sent: sent, skipped: skipped, errors: errors };
}

// Default invitation text — mirrors the Drückjagd template Jakob keeps.
// Placeholders: {date}, {teilgebiet}, {rsvp_deadline}, {written_invite_date},
// {rsvp_link}, {organizer}. Sentences whose placeholder is empty are dropped
// so the email never reads "am ." or "Teilgebiet ." with a blank.
function inviteEmailBody_(ev, hunter, rsvpLink) {
  const eventDate = formatGermanDate_(ev.date);
  const twoWeeksBefore = addDays_(ev.date, -14);
  const rsvpDeadline = formatGermanDate_(ev.rsvp_deadline || twoWeeksBefore);
  const writtenInvite = formatGermanDate_(twoWeeksBefore);
  const teilgebiet = String(ev.teilgebiet || "").trim();
  const organizer = String(ev.organizer || "").trim() || "Jakob";

  const sentence1 = "ich möchte Euch alle recht herzlich zur nächsten Drückjagd in Peenwerder am " +
    (eventDate || "[noch offen]") + " einladen." +
    (teilgebiet ? " " + teilgebietSentence_(teilgebiet) : "");

  const lines = [
    "Liebe Freundinnen und Freunde des Waldbaus,",
    "",
    sentence1,
    "",
    "Ich bitte Euch, mir bis zum " + (rsvpDeadline || "[noch offen]") +
      " eine verbindliche Zusage zu machen, wenn und in welcher Funktion Ihr teilnehmen möchtet (Schütze/Treiber/Hundeführer). Nutzt dafür bitte ausschließlich diesen Anmeldelink:",
    "",
    rsvpLink,
    "",
    "Treiber können gerne mitgebracht werden, bitte vorher mit Namen anmelden.",
    "",
    "Im Laufe des " + (writtenInvite || "[noch offen]") +
      " (zwei Wochen vorher) werdet Ihr von mir dann eine schriftliche Einladung erhalten, aus der ihr alle Details zur Anreise und zum Ablauf entnehmen könnt.",
    "",
    "Ich freue mich auf zahlreiches Erscheinen und dass wir waidgerecht und mit Freude gemeinsam Beute machen. Horrido!",
    "",
    "euer " + organizer,
  ];
  return lines.join("\n");
}

// "Hauptrevier" → "Wir bejagen das Teilgebiet Hauptrevier."
// "Hauptrevier, Ost" → "Wir bejagen die Teilgebiete Hauptrevier und Ost."
// "Hauptrevier, Ost, Nord" → "Wir bejagen die Teilgebiete Hauptrevier, Ost und Nord."
function teilgebietSentence_(raw) {
  const parts = String(raw || "").split(/\s*,\s*/).filter(function (p) { return p; });
  if (parts.length === 0) return "";
  if (parts.length === 1) return "Wir bejagen das Teilgebiet " + parts[0] + ".";
  const last = parts[parts.length - 1];
  const head = parts.slice(0, -1).join(", ");
  return "Wir bejagen die Teilgebiete " + head + " und " + last + ".";
}

function formatGermanDate_(isoDate) {
  const s = String(isoDate || "").trim();
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni",
                  "Juli", "August", "September", "Oktober", "November", "Dezember"];
  return parseInt(m[3], 10) + ". " + MONTHS[parseInt(m[2], 10) - 1] + " " + m[1];
}

function addDays_(isoDate, days) {
  const s = String(isoDate || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return yyyy + "-" + mm + "-" + dd;
}

function rsvpInfo_(params) {
  const token = String((params && params.token) || "").trim();
  if (!token) return { error: "token required" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEETS.event_hunters, EVENT_HUNTER_HEADER);
  const eh = readSheet_(SHEETS.event_hunters, EVENT_HUNTER_HEADER)
    .find(function (h) { return String(h.token) === token; });
  if (!eh) return { error: "invalid token" };
  const ev = readSheet_(SHEETS.events, EVENT_HEADER)
    .find(function (e) { return String(e.id) === String(eh.event_id); });
  if (!ev) return { error: "event not found" };
  let dogs = [];
  try { dogs = JSON.parse(String(eh.dogs || "[]")); } catch (e) {}
  return {
    hunter: String(eh.hunter || ""),
    status: String(eh.status || ""),
    role: String(eh.role || ""),
    dogs: Array.isArray(dogs) ? dogs : [],
    breeds: DOG_BREEDS,
    event: {
      name: String(ev.name || ""),
      date: String(ev.date || ""),
      teilgebiet: String(ev.teilgebiet || ""),
      rsvp_deadline: String(ev.rsvp_deadline || ""),
      treffpunkt: String(ev.treffpunkt || ""),
      treff_time: String(ev.treff_time || ""),
      start_time: String(ev.start_time || ""),
      end_time: String(ev.end_time || ""),
      briefing: String(ev.briefing || ""),
      organizer: String(ev.organizer || ""),
    },
  };
}

function rsvpRespond_(body) {
  const token = String(body.token || "").trim();
  const choiceRaw = String(body.choice || "").toLowerCase();
  if (!token) return { error: "token required" };
  const choice = (choiceRaw === "accept" || choiceRaw === "accepted") ? "accepted"
              : (choiceRaw === "decline" || choiceRaw === "declined") ? "declined"
              : "";
  if (!choice) return { error: "choice must be accept or decline" };
  // Role is only meaningful on accept; allowlisted so the sheet doesn't
  // fill with free-form junk. Schütze still accepted as a legacy synonym
  // for the (combined) Schütze/Standschneller option.
  const VALID_ROLES = { "Schütze/Standschneller": 1, "Schütze": 1, "Treiber": 1, "Hundeführer": 1 };
  let role = String(body.role || "").trim();
  if (role && !VALID_ROLES[role]) role = "";
  if (role === "Schütze") role = "Schütze/Standschneller";
  if (choice === "declined") role = "";

  // Dogs are optional and only valid for the two roles that can bring them.
  let dogs = [];
  if (choice === "accepted" && (role === "Schütze/Standschneller" || role === "Hundeführer") &&
      Array.isArray(body.dogs)) {
    const allowed = {};
    for (let k = 0; k < DOG_BREEDS.length; k++) allowed[DOG_BREEDS[k]] = 1;
    for (let k = 0; k < body.dogs.length && dogs.length < 8; k++) {
      const d = body.dogs[k] || {};
      const breed = String(d.breed || "").trim();
      const count = Math.max(1, Math.min(10, parseInt(d.count, 10) || 1));
      if (breed && allowed[breed]) dogs.push({ breed: breed, count: count });
    }
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.event_hunters, EVENT_HUNTER_HEADER);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: "not found" };
  const rows = sheet.getRange(2, 1, lastRow - 1, EVENT_HUNTER_HEADER.length).getValues();
  const headers = sheet.getRange(1, 1, 1, EVENT_HUNTER_HEADER.length).getValues()[0]
    .map(function (s) { return String(s).trim(); });
  const colToken = headers.indexOf("token");
  const colStatus = headers.indexOf("status");
  const colRole = headers.indexOf("role");
  const colDogs = headers.indexOf("dogs");
  const colResponded = headers.indexOf("responded_at");
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][colToken]) === token) {
      sheet.getRange(i + 2, colStatus + 1).setValue(choice);
      if (colRole >= 0) sheet.getRange(i + 2, colRole + 1).setValue(role);
      if (colDogs >= 0) sheet.getRange(i + 2, colDogs + 1).setValue(choice === "accepted" ? JSON.stringify(dogs) : "");
      sheet.getRange(i + 2, colResponded + 1).setValue(new Date().toISOString());
      return { ok: true, status: choice, role: role, dogs: dogs };
    }
  }
  return { error: "not found" };
}

function eventSquadSave_(body) {
  const eventId = String(body.event_id || "").trim();
  if (!eventId) return { error: "event_id required" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.event_squads, EVENT_SQUAD_HEADER);
  const name = String(body.name || "").trim();
  const postId = String(body.post_id || "").trim();
  const postName = String(body.post_name || "").trim();
  const briefing = String(body.briefing || "").trim();
  const members = Array.isArray(body.members)
    ? body.members.filter(function (m) { return typeof m === "string" && m.trim(); }).map(function (m) { return m.trim(); })
    : [];
  const membersJson = JSON.stringify(members);
  const id = String(body.id || "").trim();
  if (id) {
    // Update existing row.
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { error: "not found" };
    const rows = sheet.getRange(2, 1, lastRow - 1, EVENT_SQUAD_HEADER.length).getValues();
    const headers = sheet.getRange(1, 1, 1, EVENT_SQUAD_HEADER.length).getValues()[0]
      .map(function (s) { return String(s).trim(); });
    const idCol = headers.indexOf("id");
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][idCol]) === id) {
        const row = [id, eventId, name, postId, postName, briefing, membersJson];
        sheet.getRange(i + 2, 1, 1, EVENT_SQUAD_HEADER.length).setValues([row]);
        return { ok: true, id: id };
      }
    }
    return { error: "not found" };
  }
  const newId = "ES-" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
  appendByName_(sheet, {
    id: newId,
    event_id: eventId,
    name: name,
    post_id: postId,
    post_name: postName,
    briefing: briefing,
    members: membersJson,
  });
  return { ok: true, id: newId };
}

function eventSquadDelete_(body) {
  const id = String(body.id || "").trim();
  if (!id) return { error: "id required" };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.event_squads, EVENT_SQUAD_HEADER);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { error: "not found" };
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === id) {
      sheet.deleteRow(i + 2);
      return { ok: true };
    }
  }
  return { error: "not found" };
}

function addressBookList_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEETS.address_book, ADDRESS_BOOK_HEADER);
  return readSheet_(SHEETS.address_book, ADDRESS_BOOK_HEADER).map(function (r) {
    return { name: String(r.name || ""), email: String(r.email || "") };
  });
}

function addressBookUpsert_(name, email) {
  if (!name || !email) return;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.address_book, ADDRESS_BOOK_HEADER);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const rows = sheet.getRange(2, 1, lastRow - 1, ADDRESS_BOOK_HEADER.length).getValues();
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][0]).trim().toLowerCase() === name.toLowerCase()) {
        sheet.getRange(i + 2, 2).setValue(email);
        return;
      }
    }
  }
  sheet.appendRow([name, email]);
}

function randomToken_() {
  // 16 url-safe hex chars from Apps Script's UUID — enough to be
  // unguessable for an invitation link in a small hunting group.
  return Utilities.getUuid().replace(/-/g, "").slice(0, 16);
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

  // Upsert INLINED_POSTS — update by ID if the row exists, append if not.
  // Critically, this *preserves* user-created KS- / P- / FREE- prefixed
  // rows (Klettersitz / Pirsch). Earlier setup() wiped the whole posts
  // sheet and silently nuked those entries.
  const lastRow = postsSheet.getLastRow();
  const idToRow = {};
  if (lastRow > 1) {
    const existing = postsSheet.getRange(2, 1, lastRow - 1, POST_HEADER.length).getValues();
    for (let i = 0; i < existing.length; i++) {
      idToRow[String(existing[i][0]).trim()] = i + 2;
    }
  }
  const appended = [];
  for (let i = 0; i < INLINED_POSTS.length; i++) {
    const p = INLINED_POSTS[i];
    const row = [p.id, p.name, p.area, p.lat, p.lng];
    const rowIdx = idToRow[p.id];
    if (rowIdx) {
      postsSheet.getRange(rowIdx, 1, 1, POST_HEADER.length).setValues([row]);
    } else {
      appended.push(row);
    }
  }
  if (appended.length > 0) {
    postsSheet.getRange(postsSheet.getLastRow() + 1, 1, appended.length, POST_HEADER.length).setValues(appended);
  }
  const rows = INLINED_POSTS;
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
  installStatsTrigger();

  SpreadsheetApp.getUi().alert(
    "Importiert: " + rows.length + " Hochsitze." + syncMsg + "\n" +
    "Trigger installiert: Saison-Rollover (01:00 täglich), KML-Sync (stündlich).\n\n" +
    "Trage jetzt im hunters-Tab Namen ein, dann Bereitstellen → Neue Bereitstellung → Web App."
  );
}

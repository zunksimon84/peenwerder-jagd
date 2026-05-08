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
const HARVEST_HEADER = ["timestamp", "hunter", "post_id", "species", "count", "notes"];

// ---------- HTTP entrypoints ----------

function doGet(e) {
  try {
    const action = (e.parameter && e.parameter.action) || "bootstrap";
    if (action === "bootstrap") return json_(bootstrap_());
    if (action === "aggregates") return json_(aggregates_(e.parameter || {}));
    return json_({ error: "unknown action" }, 400);
  } catch (err) {
    return json_({ error: String(err && err.message || err) }, 500);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || "{}");
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
  const post_id = String(body.post_id || "").trim();
  const speciesVal = String(body.species || "").trim();
  const count = Number(body.count);
  const notes = String(body.notes || "").trim();

  if (!hunter) return { error: "hunter required" };
  if (hunter.length > 40) return { error: "hunter name too long" };
  // Allow letters (incl. umlauts), spaces, hyphens, apostrophes, dots.
  if (!/^[\p{L}][\p{L}\s.\-']{0,39}$/u.test(hunter)) {
    return { error: "hunter name has invalid characters" };
  }
  if (!post_id) return { error: "post_id required" };
  if (!speciesVal) return { error: "species required" };
  if (!Number.isFinite(count) || count < 1 || count > 20) {
    return { error: "count must be 1–20" };
  }
  if (SPECIES.indexOf(speciesVal) === -1) {
    return { error: "invalid species" };
  }

  const posts = readPosts_();
  if (!posts.some(function (p) { return p.id === post_id; })) {
    return { error: "unknown post_id: " + post_id };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Auto-add hunter to roster on first use (case-insensitive match).
  const hunters = readHunters_();
  const known = hunters.find(function (h) { return h.toLowerCase() === hunter.toLowerCase(); });
  if (!known) {
    ensureSheet_(ss, SHEETS.hunters, HUNTER_HEADER).appendRow([hunter]);
  }
  const canonical = known || hunter;

  const sheet = ensureSheet_(ss, SHEETS.harvests, HARVEST_HEADER);
  sheet.appendRow([new Date().toISOString(), canonical, post_id, speciesVal, count, notes]);

  return { ok: true, hunter: canonical };
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
  }
  return sheet;
}

// ---------- Response helpers ----------

function json_(obj /*, statusCode (advisory only) */) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- One-time setup helper ----------
// Run from the Apps Script editor: Run → setupFromPostsJson
// Pastes the contents of public/posts.json into the `posts` sheet in bulk.
// Edit POSTS_JSON below before running, or paste a smaller list.
function setupFromPostsJson() {
  const POSTS_JSON = `[]`; // ← paste public/posts.json contents BETWEEN the backticks, then Run
  const posts = JSON.parse(POSTS_JSON);
  if (!posts.length) throw new Error("Paste posts.json contents into POSTS_JSON first.");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, SHEETS.posts, POST_HEADER);
  // Clear existing data rows (keep header)
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, POST_HEADER.length).clearContent();
  }
  const rows = posts.map(function (p) {
    return [p.id, p.name, p.area, p.lat, p.lng];
  });
  sheet.getRange(2, 1, rows.length, POST_HEADER.length).setValues(rows);
  SpreadsheetApp.getUi().alert("Imported " + rows.length + " posts.");
}

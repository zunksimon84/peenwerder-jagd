// Peenwerder Jagd-Heatmap — main client logic.

const cfg = window.PEENWERDER_CONFIG || {};
const MAP_CENTER = { lat: 53.6262, lng: 12.8378 };
const MAP_ZOOM = 13;

const state = {
  posts: [],
  hunters: [],
  species: [],
  aggregates: new Map(), // post_id → total_count
  map: null,
  heatmap: null,
  markers: new Map(),    // post_id → marker
  selectedPostId: null,
  filters: { species: "", range: "season" },
};

const $ = (sel) => document.querySelector(sel);

// ---------------- Bootstrapping ----------------

async function main() {
  if (!cfg.GOOGLE_MAPS_API_KEY || cfg.GOOGLE_MAPS_API_KEY.startsWith("PASTE")) {
    showToast("Konfiguration fehlt: public/config.js", "error", 8000);
    return;
  }
  try {
    await loadMapsScript(cfg.GOOGLE_MAPS_API_KEY);
    initMap();
    await bootstrap();
    renderMarkers();
    await refreshAggregates();
    wireUi();
  } catch (err) {
    console.error(err);
    showToast("Fehler beim Laden: " + err.message, "error", 6000);
  }
}

function loadMapsScript(apiKey) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) return resolve();
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey
    )}&libraries=visualization&v=weekly`;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google Maps konnte nicht geladen werden"));
    document.head.appendChild(s);
  });
}

function initMap() {
  state.map = new google.maps.Map($("#map"), {
    center: MAP_CENTER,
    zoom: MAP_ZOOM,
    mapTypeId: "hybrid",
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    gestureHandling: "greedy",
  });
}

async function bootstrap() {
  // Try Apps Script first; fall back to baked-in posts.json so the map at
  // least renders if the backend isn't configured yet.
  if (cfg.APPS_SCRIPT_URL && !cfg.APPS_SCRIPT_URL.startsWith("PASTE")) {
    try {
      const res = await fetch(cfg.APPS_SCRIPT_URL + "?action=bootstrap");
      if (res.ok) {
        const data = await res.json();
        state.posts = data.posts || [];
        state.hunters = data.hunters || [];
        state.species = data.species || [];
        return;
      }
    } catch (err) {
      console.warn("Bootstrap from Apps Script failed, falling back:", err);
    }
  }
  // Fallback: posts.json + hardcoded species, no hunters.
  const res = await fetch("posts.json");
  state.posts = await res.json();
  state.hunters = [];
  state.species = ["Rehwild", "Schwarzwild", "Rotwild", "Damwild", "Fuchs", "Dachs", "Hase", "Sonstiges"];
  showToast("Backend nicht konfiguriert — nur Anzeige", "error", 5000);
}

// ---------------- Rendering ----------------

const AREA_COLOR = {
  Hauptrevier: "#2e7d32",
  Ost: "#1565c0",
  Nord: "#ef6c00",
  Nordrand: "#6a1b9a",
  Klettersitz: "#03a9f4", // bright blue — hunter-created mobile climber stands
  Pirsch: "#fdd835", // yellow — hunter-created stalking locations
};

const FREE_AREAS = new Set(["Klettersitz", "Pirsch"]);

const MARKER_SCALE = { Pirsch: 3, Klettersitz: 4 }; // default 5 for fixed Kanzeln

function addMarkerForPost(post) {
  if (state.markers.has(post.id)) return;
  if (!Number.isFinite(post.lat) || !Number.isFinite(post.lng)) return;
  const isFree = FREE_AREAS.has(post.area);
  const marker = new google.maps.Marker({
    position: { lat: post.lat, lng: post.lng },
    map: state.map,
    title: post.name,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      fillColor: AREA_COLOR[post.area] || "#444",
      fillOpacity: isFree ? 0.7 : 0.9,
      strokeColor: "#fff",
      strokeWeight: isFree ? 1 : 1.5,
      scale: MARKER_SCALE[post.area] || 5,
    },
  });
  marker.addListener("click", () => openSheet(post.id));
  state.markers.set(post.id, marker);
}

function renderMarkers() {
  for (const post of state.posts) addMarkerForPost(post);
}

function renderHeatmap() {
  if (state.heatmap) state.heatmap.setMap(null);
  const points = [];
  for (const post of state.posts) {
    const count = state.aggregates.get(post.id) || 0;
    if (count <= 0) continue;
    if (!Number.isFinite(post.lat) || !Number.isFinite(post.lng)) continue;
    points.push({
      location: new google.maps.LatLng(post.lat, post.lng),
      // Floor to 2 so a single harvest is still visible. 2+ stays linear.
      weight: Math.max(count, 2),
    });
  }
  state.heatmap = new google.maps.visualization.HeatmapLayer({
    data: points,
    map: state.map,
    radius: 30,
    opacity: 0.5,
    // 20 harvests at one post = full red. Below that ramps linearly:
    // 5 = 25% intensity, 10 = 50%, 20+ = 100%.
    maxIntensity: 20,
    dissipating: true,
  });
  renderLeaderboard();
}

function renderLeaderboard() {
  const top = [...state.aggregates.entries()]
    .map(([id, n]) => ({ id, n, post: state.posts.find((p) => p.id === id) }))
    .filter((r) => r.post)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  const list = $("#leaderboard-list");
  $("#leaderboard").hidden = top.length === 0;
  list.innerHTML = "";
  for (const r of top) {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="lb-name">${escapeHtml(r.post.name)}</span>` +
      `<strong class="lb-count">${r.n}</strong>`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => {
      state.map.panTo({ lat: r.post.lat, lng: r.post.lng });
      state.map.setZoom(15);
    });
    list.appendChild(li);
  }
}

// ---------------- Aggregates ----------------

async function refreshAggregates() {
  state.aggregates.clear();
  if (cfg.APPS_SCRIPT_URL && !cfg.APPS_SCRIPT_URL.startsWith("PASTE")) {
    try {
      const url = new URL(cfg.APPS_SCRIPT_URL);
      url.searchParams.set("action", "aggregates");
      const range = rangeToDates(state.filters.range);
      if (range.from) url.searchParams.set("from", range.from);
      if (range.to) url.searchParams.set("to", range.to);
      if (state.filters.species) url.searchParams.set("species", state.filters.species);
      const res = await fetch(url.toString());
      if (res.ok) {
        const data = await res.json();
        for (const row of data) state.aggregates.set(row.post_id, row.total_count);
      }
    } catch (err) {
      console.warn("Aggregates fetch failed:", err);
    }
  }
  renderHeatmap();
}

// German hunting season runs roughly April 1 → March 31 of next year.
function seasonStart(now = new Date()) {
  const y = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return new Date(Date.UTC(y, 3, 1)); // April 1, UTC
}

function rangeToDates(range) {
  const now = new Date();
  if (range === "all") return {};
  if (range === "season") return { from: seasonStart(now).toISOString() };
  if (range === "30d") return { from: new Date(now - 30 * 86400000).toISOString() };
  if (range === "7d") return { from: new Date(now - 7 * 86400000).toISOString() };
  if (range === "today") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return { from: startOfDay.toISOString() };
  }
  return {};
}

// ---------------- Sheet / form ----------------

function setSheetMode(mode) {
  state.sheetMode = mode;
  // Modes Klettersitz/Pirsch share the same coord-input UI (they only
  // differ in what gets stored on submit), so map both to "coords".
  const displayGroup = mode === "post" ? "post" : "coords";
  document.querySelectorAll(".mode-btn").forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-mode-show]").forEach((el) => {
    el.classList.toggle("visible", el.dataset.modeShow === displayGroup);
  });
  // History only makes sense for an existing post; coord modes are for
  // creating a brand-new location, so hide it.
  if (mode === "post") {
    loadHistory($("#f-post").value);
  } else {
    $("#history").hidden = true;
  }
}

const HISTORY_DATE_FMT = new Intl.DateTimeFormat("de-DE", {
  day: "numeric", month: "short", year: "numeric",
});

async function loadHistory(postId) {
  const histEl = $("#history");
  const listEl = $("#history-list");
  if (!postId) {
    histEl.hidden = true;
    return;
  }
  if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.startsWith("PASTE")) {
    histEl.hidden = true;
    return;
  }
  // Quick placeholder so the sheet doesn't flicker empty during the fetch.
  listEl.innerHTML = "";
  histEl.hidden = false;
  try {
    const url = new URL(cfg.APPS_SCRIPT_URL);
    url.searchParams.set("action", "history");
    url.searchParams.set("post_id", postId);
    url.searchParams.set("limit", "20");
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    // Race guard: if the dropdown moved on while we were waiting, drop this.
    if ($("#f-post").value !== postId || state.sheetMode !== "post") return;
    listEl.innerHTML = "";
    if (!Array.isArray(data) || data.length === 0) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Noch keine Strecke an dieser Stelle.";
      listEl.appendChild(p);
      return;
    }
    for (const h of data) {
      const li = document.createElement("li");
      const when = h.timestamp ? HISTORY_DATE_FMT.format(new Date(h.timestamp)) : "—";
      li.innerHTML =
        `<span class="when">${when}</span>` +
        `<strong>${escapeHtml(h.species)}</strong> ×${h.count}` +
        ` <span class="who">${escapeHtml(h.hunter)}</span>` +
        windHtml(h.wind_speed, h.wind_dir);
      listEl.appendChild(li);
    }
  } catch (err) {
    console.warn("history fetch failed:", err);
    histEl.hidden = true;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

const COMPASS_16 = ["N","NNO","NO","ONO","O","OSO","SO","SSO","S","SSW","SW","WSW","W","WNW","NW","NNW"];

function degToCompass(deg) {
  if (!Number.isFinite(deg)) return "";
  return COMPASS_16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// Tiny inline wind indicator: arrow points to where the wind is COMING
// FROM (meteorological convention; what hunters actually want), with the
// speed in km/h beside it. Tooltip gives compass direction.
function windHtml(speed, dir) {
  if (speed == null || dir == null) return "";
  const compass = degToCompass(dir);
  const tip = `Wind aus ${compass} (${Math.round(dir)}°), ${speed} km/h`;
  return ` <span class="wind" title="${tip}">` +
    `<svg viewBox="0 0 12 12" style="transform: rotate(${dir}deg)" aria-hidden="true">` +
    `<path d="M6 1 L6 11 M6 1 L3 5 M6 1 L9 5" stroke="currentColor" stroke-width="1.4" ` +
    `fill="none" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>${speed} km/h</span>`;
}

function openSheet(postId) {
  state.selectedPostId = postId || null;
  const postSel = $("#f-post");
  postSel.innerHTML = "";
  for (const p of state.posts) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.area})`;
    if (p.id === postId) opt.selected = true;
    postSel.appendChild(opt);
  }

  const hunterSel = $("#f-hunter");
  hunterSel.innerHTML = "";
  const last = localStorage.getItem("peenwerder.hunter");
  for (const h of state.hunters) {
    const opt = document.createElement("option");
    opt.value = h;
    opt.textContent = h;
    if (h === last) opt.selected = true;
    hunterSel.appendChild(opt);
  }
  if (state.hunters.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = "— bitte Namen anlegen —";
    hunterSel.appendChild(opt);
  }
  // "+ Neuer Jäger…" entry — picking it prompts for a fresh name, which
  // gets added as a temporary option and selected. The backend will
  // persist it to the hunters tab on first successful submit.
  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = "+ Neuer Jäger…";
  hunterSel.appendChild(newOpt);

  const speciesSel = $("#f-species");
  speciesSel.innerHTML = "";
  for (const s of state.species) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    speciesSel.appendChild(opt);
  }

  $("#f-count").value = "1";
  $("#f-notes").value = "";
  $("#f-free-label").value = "";
  $("#f-free-lat").value = "";
  $("#f-free-lng").value = "";
  setSheetMode("post"); // Klettersitz is opt-in via the toggle.
  $("#sheet").hidden = false;
  $("#sheet-backdrop").hidden = false;
}

function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet-backdrop").hidden = true;
}

async function submitHarvest(ev) {
  ev.preventDefault();
  const submitBtn = $("#f-submit");
  submitBtn.disabled = true;
  try {
    const body = {
      hunter: $("#f-hunter").value.trim(),
      species: $("#f-species").value,
      count: Number($("#f-count").value),
      notes: $("#f-notes").value.trim(),
    };
    if (!body.hunter || body.hunter === "__new__") throw new Error("Bitte Jäger wählen");
    if (body.hunter.length > 40) throw new Error("Name zu lang (max 40)");
    if (state.sheetMode === "post") {
      body.post_id = $("#f-post").value;
      if (!body.post_id) throw new Error("Bitte Kanzel auswählen");
    } else {
      // Klettersitz or Pirsch — same coord inputs, kind decides storage.
      const latStr = $("#f-free-lat").value.trim();
      const lngStr = $("#f-free-lng").value.trim();
      if (!latStr || !lngStr) {
        throw new Error("Bitte Koordinaten eingeben oder 'Aktuelle Position' nutzen");
      }
      const lat = Number(latStr);
      const lng = Number(lngStr);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new Error("Breitengrad muss zwischen −90 und 90 liegen");
      }
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new Error("Längengrad muss zwischen −180 und 180 liegen");
      }
      body.free_location = {
        lat,
        lng,
        label: $("#f-free-label").value.trim(),
        kind: state.sheetMode, // "klettersitz" or "pirsch"
      };
    }
    localStorage.setItem("peenwerder.hunter", body.hunter);

    // text/plain keeps this a "simple" CORS request; no preflight needed.
    const res = await fetch(cfg.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Fehler beim Speichern");

    const canonical = data.hunter || body.hunter;
    if (!state.hunters.some((h) => h.toLowerCase() === canonical.toLowerCase())) {
      state.hunters.push(canonical);
      state.hunters.sort((a, b) => a.localeCompare(b, "de"));
    }
    // If the backend created a Klettersitz post, surface it on the map immediately.
    if (data.post && !state.posts.some((p) => p.id === data.post.id)) {
      state.posts.push(data.post);
      addMarkerForPost(data.post);
    }
    showToast("Eingetragen ✓");
    closeSheet();
    await refreshAggregates();
  } catch (err) {
    showToast(err.message, "error", 4000);
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------------- Geolocation helper ----------------

function nearestPost(lat, lng, predicate) {
  let best = null;
  let bestDist = Infinity;
  for (const p of state.posts) {
    if (predicate && !predicate(p)) continue;
    const d = haversine(lat, lng, p.lat, p.lng);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------- UI wiring ----------------

function wireUi() {
  // Populate species filter dropdown
  const filterSpecies = $("#filter-species");
  for (const s of state.species) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    filterSpecies.appendChild(opt);
  }

  filterSpecies.addEventListener("change", (e) => {
    state.filters.species = e.target.value;
    refreshAggregates();
  });
  $("#filter-range").addEventListener("change", (e) => {
    state.filters.range = e.target.value;
    refreshAggregates();
  });

  $("#fab").addEventListener("click", () => openSheet(null));
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#f-cancel").addEventListener("click", closeSheet);
  $("#sheet-backdrop").addEventListener("click", closeSheet);
  $("#harvest-form").addEventListener("submit", submitHarvest);

  $("#strecke-btn").addEventListener("click", openStrecke);
  $("#strecke-close").addEventListener("click", closeStrecke);
  $("#strecke-close-bottom").addEventListener("click", closeStrecke);
  $("#strecke-backdrop").addEventListener("click", closeStrecke);

  document.querySelectorAll(".counter button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const step = Number(btn.dataset.step);
      const input = $("#f-count");
      const next = Math.max(1, Math.min(20, Number(input.value) + step));
      input.value = String(next);
    });
  });

  $("#f-nearest").addEventListener("click", () => {
    if (!navigator.geolocation) {
      showToast("Standort nicht verfügbar", "error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Skip free-coord posts when picking the nearest fixed Kanzel.
        const p = nearestPost(pos.coords.latitude, pos.coords.longitude, (x) => !FREE_AREAS.has(x.area));
        if (p) {
          $("#f-post").value = p.id;
          showToast(`Nächste: ${p.name}`);
        }
      },
      (err) => showToast("Standort: " + err.message, "error", 4000),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });

  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.addEventListener("click", () => setSheetMode(b.dataset.mode));
  });

  $("#f-post").addEventListener("change", (e) => {
    if (state.sheetMode === "post") loadHistory(e.target.value);
  });

  $("#f-hunter").addEventListener("change", (e) => {
    if (e.target.value !== "__new__") return;
    const raw = (window.prompt("Name des neuen Jägers:") || "").trim();
    const valid = /^[\p{L}][\p{L}\s.\-']{0,39}$/u.test(raw);
    if (!valid) {
      // Bail back to the previously stored name (or the first real option).
      const last = localStorage.getItem("peenwerder.hunter") || "";
      e.target.value = state.hunters.includes(last) ? last : (state.hunters[0] || "");
      if (raw) showToast("Name ungültig (nur Buchstaben, max 40)", "error", 3000);
      return;
    }
    // Insert as a real option above "+ Neuer Jäger…" and select it.
    const opt = document.createElement("option");
    opt.value = raw;
    opt.textContent = raw;
    e.target.insertBefore(opt, e.target.querySelector('option[value="__new__"]'));
    opt.selected = true;
  });

  $("#f-free-here").addEventListener("click", () => {
    if (!navigator.geolocation) {
      showToast("Standort nicht verfügbar", "error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $("#f-free-lat").value = pos.coords.latitude.toFixed(6);
        $("#f-free-lng").value = pos.coords.longitude.toFixed(6);
        showToast("Position übernommen");
      },
      (err) => showToast("Standort: " + err.message, "error", 4000),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// ---------------- Toast ----------------

// ---------------- Strecke modal ----------------

const RANGE_LABEL = {
  all: "Gesamt",
  season: "Diese Saison",
  "30d": "Letzte 30 Tage",
  "7d": "Letzte 7 Tage",
  today: "Heute",
};

async function openStrecke() {
  const list = $("#strecke-list");
  const totalEl = $("#strecke-total");
  const rangeEl = $("#strecke-range");
  list.innerHTML = "";
  totalEl.textContent = "…";
  rangeEl.textContent = RANGE_LABEL[state.filters.range] || "";
  $("#strecke-backdrop").hidden = false;
  $("#strecke-modal").hidden = false;
  if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.startsWith("PASTE")) {
    totalEl.textContent = "—";
    return;
  }
  try {
    const url = new URL(cfg.APPS_SCRIPT_URL);
    url.searchParams.set("action", "strecke");
    const r = rangeToDates(state.filters.range);
    if (r.from) url.searchParams.set("from", r.from);
    if (r.to) url.searchParams.set("to", r.to);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    totalEl.textContent = String(data.total || 0);
    if (!data.by_species || data.by_species.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Noch keine Strecke in diesem Zeitraum.";
      list.appendChild(li);
      return;
    }
    for (const row of data.by_species) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = row.species;
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = row.count;
      li.appendChild(name);
      li.appendChild(count);
      list.appendChild(li);
    }
    renderTimeline(data);
  } catch (err) {
    totalEl.textContent = "—";
    showToast("Strecke konnte nicht geladen werden", "error", 4000);
    console.warn(err);
  }
}

function closeStrecke() {
  $("#strecke-modal").hidden = true;
  $("#strecke-backdrop").hidden = true;
}

// Cumulative-count sparkline across the full Apr 1 → Mar 31 season.
// Steeper segments = peak weeks. A vertical line marks "today" so the
// season's progress is obvious at a glance.
function renderTimeline(data) {
  const wrap = $("#strecke-timeline");
  const svg = $("#timeline-svg");
  const todayLbl = $("#timeline-today");
  if (!data.season_start || !data.season_end) {
    wrap.hidden = true;
    return;
  }
  const startMs = new Date(data.season_start).getTime();
  const endMs = new Date(data.season_end).getTime();
  const span = Math.max(endMs - startMs, 1);
  const W = 320, H = 60, PAD_X = 4, PAD_Y = 4;
  const usableW = W - 2 * PAD_X;
  const usableH = H - 2 * PAD_Y;

  const daily = Array.isArray(data.daily) ? data.daily : [];
  const totalCum = daily.reduce((s, d) => s + (d.count || 0), 0);
  const yMax = Math.max(totalCum, 1);

  // Build a stepped path: horizontal until the next harvest day, then
  // vertical jump up by that day's count.
  let cum = 0;
  const segs = [`M ${PAD_X} ${H - PAD_Y}`];
  for (const d of daily) {
    const dayMs = new Date(d.day).getTime();
    if (isNaN(dayMs)) continue;
    const x = PAD_X + ((dayMs - startMs) / span) * usableW;
    const yPrev = H - PAD_Y - (cum / yMax) * usableH;
    segs.push(`L ${x.toFixed(1)} ${yPrev.toFixed(1)}`);
    cum += d.count || 0;
    const yNew = H - PAD_Y - (cum / yMax) * usableH;
    segs.push(`L ${x.toFixed(1)} ${yNew.toFixed(1)}`);
  }
  segs.push(`L ${(W - PAD_X).toFixed(1)} ${(H - PAD_Y - (cum / yMax) * usableH).toFixed(1)}`);

  // "Today" vertical line
  const nowMs = Date.now();
  const todayX =
    nowMs >= startMs && nowMs <= endMs
      ? PAD_X + ((nowMs - startMs) / span) * usableW
      : null;
  todayLbl.textContent = todayX != null
    ? `Heute: ${new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "short" }).format(new Date(nowMs))}`
    : "";

  svg.innerHTML =
    `<line x1="${PAD_X}" y1="${H - PAD_Y}" x2="${W - PAD_X}" y2="${H - PAD_Y}" stroke="#d8d4c8" stroke-width="0.5"/>` +
    (todayX != null
      ? `<line x1="${todayX.toFixed(1)}" y1="${PAD_Y}" x2="${todayX.toFixed(1)}" y2="${H - PAD_Y}" stroke="#b94a2c" stroke-width="0.6" stroke-dasharray="2 2"/>`
      : "") +
    `<path d="${segs.join(" ")}" fill="none" stroke="#1f3a1f" stroke-width="1.5" stroke-linejoin="round"/>`;

  wrap.hidden = false;
}

let toastTimer = null;
function showToast(msg, kind, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = kind === "error" ? "error" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

main();

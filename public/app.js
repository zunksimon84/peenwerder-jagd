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
  heatOverlay: null,     // heatmap.js OverlayView wrapper
  markers: new Map(),    // post_id → marker
  selectedPostId: null,
  filters: { species: "", range: "season" },
};

const $ = (sel) => document.querySelector(sel);

// ---------------- Bootstrapping ----------------

async function main() {
  setupViewportInsets();
  if (!cfg.GOOGLE_MAPS_API_KEY || cfg.GOOGLE_MAPS_API_KEY.startsWith("PASTE")) {
    showToast("Konfiguration fehlt: public/config.js", "error", 8000);
    return;
  }
  try {
    if (!(await passGate())) return; // private + wrong/missing password
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

// Build a URL for the Apps Script backend with action + params + (if set)
// access token. All data fetches go through this so going private is a
// one-flag flip.
function backendUrl(action, params = {}) {
  const u = new URL(cfg.APPS_SCRIPT_URL);
  u.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") u.searchParams.set(k, v);
  }
  const token = localStorage.getItem("preye.token");
  if (token) u.searchParams.set("token", token);
  return u.toString();
}

async function passGate() {
  if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.startsWith("PASTE")) return true;
  let isPublic = true;
  try {
    const res = await fetch(cfg.APPS_SCRIPT_URL + "?action=site-status");
    const data = await res.json();
    isPublic = !!data.is_public;
  } catch (err) {
    console.warn("site-status check failed, allowing through:", err);
    return true;
  }
  if (isPublic) return true;
  const cached = localStorage.getItem("preye.token");
  if (cached) {
    try {
      const v = await fetch(cfg.APPS_SCRIPT_URL + "?action=verify-access&token=" + encodeURIComponent(cached));
      const vr = await v.json();
      if (vr.ok) return true;
    } catch (err) {
      // fall through to prompt
    }
    localStorage.removeItem("preye.token");
  }
  return showGate();
}

function showGate() {
  return new Promise((resolve) => {
    const gate = $("#gate");
    const form = $("#gate-form");
    const input = $("#gate-pw");
    const errorEl = $("#gate-error");
    gate.hidden = false;
    setTimeout(() => input.focus(), 50);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const password = input.value;
      if (!password) return;
      errorEl.hidden = true;
      const submitBtn = form.querySelector("button");
      submitBtn.disabled = true;
      try {
        const res = await fetch(
          cfg.APPS_SCRIPT_URL + "?action=verify-access&password=" + encodeURIComponent(password)
        );
        const data = await res.json();
        if (data.ok && data.token) {
          localStorage.setItem("preye.token", data.token);
          gate.hidden = true;
          resolve(true);
        } else {
          errorEl.textContent = "Falsches Passwort.";
          errorEl.hidden = false;
          input.select();
        }
      } catch (err) {
        errorEl.textContent = "Fehler: " + (err.message || err);
        errorEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    };
  });
}

// Track iOS Chrome / Safari URL-bar position so position:fixed modals
// can sit above (not behind) the browser chrome. CSS env() doesn't expose
// browser chrome — visualViewport does.
function setupViewportInsets() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const top = Math.max(0, vv.offsetTop);
    const bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty("--vv-top", top + "px");
    root.style.setProperty("--vv-bottom", bottom + "px");
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}

function loadMapsScript(apiKey) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) return resolve();
    const s = document.createElement("script");
    // No more &libraries=visualization — the bundled HeatmapLayer is
    // deprecated. We render heat via deck.gl's GoogleMapsOverlay instead.
    // Not using loading=async because that switches Maps to importLibrary
    // mode and our code uses synchronous google.maps.Map / Marker globals.
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
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
  // OverlayView.draw() auto-fires on zoom/pan, so the heatmap recomputes
  // canvas size + zoom-aware radius without us listening explicitly.
}

async function bootstrap() {
  // Try Apps Script first; fall back to baked-in posts.json so the map at
  // least renders if the backend isn't configured yet.
  if (cfg.APPS_SCRIPT_URL && !cfg.APPS_SCRIPT_URL.startsWith("PASTE")) {
    try {
      const res = await fetch(backendUrl("bootstrap"));
      if (res.ok) {
        const data = await res.json();
        state.posts = data.posts || [];
        state.hunters = (data.hunters || []).slice().sort((a, b) => a.localeCompare(b, "de"));
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

// Custom canvas-based heatmap overlay. For each post we draw a radial
// gradient onto a 2D canvas using "lighter" (additive) compositing, then
// post-process the alpha channel through a color ramp so density maps to
// the blue → yellow → red gradient. No external library needed.

let HeatmapOverlayClass = null;

const HEAT_GRADIENT = (() => {
  // 256-entry RGBA lookup: index = density (0-255), value = [r,g,b,a].
  // Calibration with intensity = weight / 20:
  //  1 harvest  → 0.05 → BLUE
  //  4 harvests → 0.20 → GREEN
  // 10 harvests → 0.50 → YELLOW
  // 15 harvests → 0.75 → ORANGE
  // 20 harvests → 1.00 → RED
  // Smooth interpolation between stops gives every count 1-20 a slightly
  // different color so each additional harvest visibly nudges the blob.
  const stops = [
    [0.00, [44, 123, 182, 0]],
    [0.02, [44, 123, 182, 130]],   // fade-in along blob edges
    [0.05, [44, 123, 182, 205]],   // BLUE   (1 harvest)
    [0.20, [102, 189, 99, 220]],   // GREEN  (4 harvests)
    [0.50, [253, 219, 90, 235]],   // YELLOW (10)
    [0.75, [253, 141, 60, 248]],   // ORANGE (15)
    [1.00, [215, 25, 28, 255]],    // RED    (20+)
  ];
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let k = 1; k < stops.length; k++) {
      if (stops[k][0] >= t) { hi = stops[k]; lo = stops[k - 1]; break; }
    }
    const span = hi[0] - lo[0] || 1;
    const f = (t - lo[0]) / span;
    lut[i * 4 + 0] = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * f);
    lut[i * 4 + 1] = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * f);
    lut[i * 4 + 2] = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * f);
    lut[i * 4 + 3] = Math.round(lo[1][3] + (hi[1][3] - lo[1][3]) * f);
  }
  return lut;
})();

function defineHeatmapOverlay() {
  if (HeatmapOverlayClass) return HeatmapOverlayClass;
  HeatmapOverlayClass = class extends google.maps.OverlayView {
    constructor() {
      super();
      this._points = [];
      this._canvas = null;
      this._ctx = null;
    }
    onAdd() {
      const canvas = document.createElement("canvas");
      canvas.style.position = "absolute";
      canvas.style.pointerEvents = "none";
      canvas.style.left = "0";
      canvas.style.top = "0";
      this._canvas = canvas;
      this._ctx = canvas.getContext("2d");
      this.getPanes().overlayLayer.appendChild(canvas);
    }
    onRemove() {
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      this._canvas = null;
      this._ctx = null;
    }
    draw() {
      if (!this._canvas || !this._ctx) return;
      const projection = this.getProjection();
      if (!projection) return;
      const map = this.getMap();
      const bounds = map.getBounds();
      if (!bounds) return;

      const sw = projection.fromLatLngToDivPixel(bounds.getSouthWest());
      const ne = projection.fromLatLngToDivPixel(bounds.getNorthEast());
      const left = Math.min(sw.x, ne.x);
      const top = Math.min(sw.y, ne.y);
      const w = Math.max(1, Math.round(Math.abs(ne.x - sw.x)));
      const h = Math.max(1, Math.round(Math.abs(sw.y - ne.y)));

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this._canvas.style.left = left + "px";
      this._canvas.style.top = top + "px";
      this._canvas.style.width = w + "px";
      this._canvas.style.height = h + "px";
      this._canvas.width = w * dpr;
      this._canvas.height = h * dpr;

      const ctx = this._ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Zoom-aware radius (CSS px); bigger when zoomed in.
      const zoom = map.getZoom() || MAP_ZOOM;
      const radius = Math.max(18, Math.min(80, Math.round(zoom * 3.4 - 12)));

      // Pass 1: draw alpha-density blobs additively.
      ctx.globalCompositeOperation = "lighter";
      for (const p of this._points) {
        const px = projection.fromLatLngToDivPixel(new google.maps.LatLng(p.lat, p.lng));
        const x = px.x - left;
        const y = px.y - top;
        if (x < -radius || y < -radius || x > w + radius || y > h + radius) continue;
        // weight / 20: max-red anchor at 20 harvests (a season's worth at
        // a top-tier Kanzel). Color stops are placed at non-uniform
        // density values so 1 harvest is already clearly blue and each
        // additional one visibly nudges the gradient warmer.
        const intensity = Math.min(1, p.weight / 20);
        const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
        grad.addColorStop(0, `rgba(0,0,0,${intensity})`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }

      // Pass 2: color-map alpha through HEAT_GRADIENT lookup.
      ctx.globalCompositeOperation = "source-over";
      const img = ctx.getImageData(0, 0, this._canvas.width, this._canvas.height);
      const data = img.data;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a === 0) continue;
        const li = a * 4;
        data[i] = HEAT_GRADIENT[li];
        data[i + 1] = HEAT_GRADIENT[li + 1];
        data[i + 2] = HEAT_GRADIENT[li + 2];
        data[i + 3] = HEAT_GRADIENT[li + 3];
      }
      ctx.putImageData(img, 0, 0);
    }
    setPoints(points) {
      this._points = points;
      if (this._canvas) this.draw();
    }
  };
  return HeatmapOverlayClass;
}

function ensureHeatOverlay() {
  if (state.heatOverlay) return;
  if (!window.google || !window.google.maps) return;
  const Cls = defineHeatmapOverlay();
  state.heatOverlay = new Cls();
  state.heatOverlay.setMap(state.map);
}

function renderHeatmap() {
  ensureHeatOverlay();
  const points = [];
  for (const post of state.posts) {
    const count = state.aggregates.get(post.id) || 0;
    if (count <= 0) continue;
    if (!Number.isFinite(post.lat) || !Number.isFinite(post.lng)) continue;
    // Use the raw count — the new color ramp is bright enough at
    // intensity = 1/5 that a single harvest already shows clearly.
    points.push({ lat: post.lat, lng: post.lng, weight: count });
  }
  if (state.heatOverlay) state.heatOverlay.setPoints(points);
  renderLeaderboard();
}

// Same calibration as the heatmap (max red at 20), but the colors are
// slightly darkened so the digits stay readable on the leaderboard's
// white card background. Counts >20 cap at red.
function countColor(count) {
  const t = Math.min(1, count / 20);
  const stops = [
    [0.05, [25, 95, 160]],    // blue   (1 harvest)
    [0.20, [76, 160, 76]],    // green  (4)
    [0.50, [200, 150, 25]],   // amber  (10) — darker than the heatmap yellow
    [0.75, [220, 110, 30]],   // orange (15)
    [1.00, [200, 30, 30]],    // red    (20+)
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i++) {
    if (stops[i][0] >= t) { hi = stops[i]; lo = stops[i - 1]; break; }
  }
  const span = hi[0] - lo[0] || 1;
  const f = (t - lo[0]) / span;
  const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * f);
  const g = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * f);
  const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * f);
  return `rgb(${r},${g},${b})`;
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
      `<strong class="lb-count" style="color:${countColor(r.n)}">${r.n}</strong>`;
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
      const range = rangeToDates(state.filters.range);
      const res = await fetch(backendUrl("aggregates", {
        from: range.from,
        to: range.to,
        species: state.filters.species,
      }));
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
    const res = await fetch(backendUrl("history", { post_id: postId, limit: "20" }));
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
  // Always start at the top of the alphabetically-sorted list — no
  // pre-selection from localStorage so the dropdown opens at "A" each
  // time, not in the middle on whoever was last logged.
  for (const h of state.hunters) {
    const opt = document.createElement("option");
    opt.value = h;
    opt.textContent = h;
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

    // Attach the access token in the body — POST requests can't easily
    // tack on URL params under our Content-Type: text/plain rule, and we
    // need to keep the request CORS-simple.
    body.token = localStorage.getItem("preye.token") || "";
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
      // Bail back to the first option in the sorted list.
      e.target.value = state.hunters[0] || "";
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
    const r = rangeToDates(state.filters.range);
    const res = await fetch(backendUrl("strecke", { from: r.from, to: r.to }));
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

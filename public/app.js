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
};

function renderMarkers() {
  for (const post of state.posts) {
    const marker = new google.maps.Marker({
      position: { lat: post.lat, lng: post.lng },
      map: state.map,
      title: post.name,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: AREA_COLOR[post.area] || "#444",
        fillOpacity: 0.9,
        strokeColor: "#fff",
        strokeWeight: 1.5,
        scale: 5,
      },
    });
    marker.addListener("click", () => openSheet(post.id));
    state.markers.set(post.id, marker);
  }
}

function renderHeatmap() {
  if (state.heatmap) state.heatmap.setMap(null);
  const points = [];
  for (const post of state.posts) {
    const count = state.aggregates.get(post.id) || 0;
    if (count <= 0) continue;
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
    li.textContent = `${r.post.name} — ${r.n}`;
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
  return {};
}

// ---------------- Sheet / form ----------------

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

  const hunterInput = $("#f-hunter");
  const hunterList = $("#hunters-datalist");
  hunterList.innerHTML = "";
  for (const h of state.hunters) {
    const opt = document.createElement("option");
    opt.value = h;
    hunterList.appendChild(opt);
  }
  hunterInput.value = localStorage.getItem("peenwerder.hunter") || "";

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
      post_id: $("#f-post").value,
      species: $("#f-species").value,
      count: Number($("#f-count").value),
      notes: $("#f-notes").value.trim(),
    };
    if (!body.hunter) throw new Error("Bitte Namen eintippen");
    if (body.hunter.length > 40) throw new Error("Name zu lang (max 40)");
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

function nearestPost(lat, lng) {
  let best = null;
  let bestDist = Infinity;
  for (const p of state.posts) {
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
  $("#sheet-backdrop").addEventListener("click", closeSheet);
  $("#harvest-form").addEventListener("submit", submitHarvest);

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
        const p = nearestPost(pos.coords.latitude, pos.coords.longitude);
        if (p) {
          $("#f-post").value = p.id;
          showToast(`Nächste: ${p.name}`);
        }
      },
      (err) => showToast("Standort: " + err.message, "error", 4000),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// ---------------- Toast ----------------

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

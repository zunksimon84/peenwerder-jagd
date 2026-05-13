// PREYE — Drückjagd organisation page.
//
// Lives next to the main map app (same Apps Script backend, same privacy
// gate). Hash routing: #/ = list, #/new = create form, #/event/<id> =
// detail (invites + squads). Magic-link invitations go out via Gmail
// (MailApp on the backend); hunters click the link and land on rsvp.html.

const cfg = window.PEENWERDER_CONFIG || {};

const state = {
  events: [],
  addressBook: [],
  currentEvent: null,  // { event, hunters, squads }
  posts: [],           // Kanzeln, used for Ansteller-Runden Position-Dropdown
  postsLoaded: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- Stale-while-revalidate cache (localStorage) ----------
// Apps Script /exec has a 1–2 s cold-start every call. We cache the JSON
// payload of read-only endpoints in localStorage and render from the cached
// copy immediately, then quietly refresh in the background. Mutations call
// invalidateCache() so the next read fetches fresh.
const CACHE_PREFIX = "preye.cache.v1.";

function cacheKey(action, params) {
  if (!params) return CACHE_PREFIX + action;
  const sorted = Object.keys(params).sort().map((k) => k + "=" + params[k]).join("&");
  return CACHE_PREFIX + action + (sorted ? "?" + sorted : "");
}

function readCache(action, params) {
  try {
    const raw = localStorage.getItem(cacheKey(action, params));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && "data" in obj ? obj.data : null;
  } catch { return null; }
}

function writeCache(action, params, data) {
  const key = cacheKey(action, params);
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch (err) {
    if (err && err.name === "QuotaExceededError") {
      // Drop all our cache entries and try once more.
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      }
      try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
    }
  }
}

function invalidateCache(action, params) {
  try { localStorage.removeItem(cacheKey(action, params)); } catch {}
}

function invalidateCachePrefix(action) {
  try {
    const prefix = CACHE_PREFIX + action;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) localStorage.removeItem(k);
    }
  } catch {}
}

// ---------- Network ----------

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

async function fetchJson(action, params = {}) {
  const res = await fetch(backendUrl(action, params));
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function postJson(body) {
  const res = await fetch(cfg.APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...body, token: localStorage.getItem("preye.token") || "" }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "Fehler");
  return data;
}

// ---------- Privacy gate (mirrors app.js) ----------

async function passGate() {
  if (!cfg.APPS_SCRIPT_URL || cfg.APPS_SCRIPT_URL.startsWith("PASTE")) return true;
  let isPublic = true;
  try {
    const res = await fetch(cfg.APPS_SCRIPT_URL + "?action=site-status");
    const data = await res.json();
    isPublic = !!data.is_public;
  } catch (err) {
    return true;
  }
  if (isPublic) return true;
  const cached = localStorage.getItem("preye.token");
  if (cached) {
    try {
      const v = await fetch(cfg.APPS_SCRIPT_URL + "?action=verify-access&token=" + encodeURIComponent(cached));
      const vr = await v.json();
      if (vr.ok) return true;
    } catch (err) {}
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
    const submitBtn = form.querySelector("button");
    gate.hidden = false;
    setTimeout(() => input.focus(), 50);
    let inflight = false;
    async function attempt() {
      if (inflight) return;
      const password = input.value;
      if (!password) return;
      inflight = true;
      errorEl.hidden = true;
      submitBtn.disabled = true;
      try {
        const url = cfg.APPS_SCRIPT_URL + "?action=verify-access&password=" + encodeURIComponent(password);
        const res = await fetch(url, { redirect: "follow" });
        const data = await res.json();
        if (data && data.ok && data.token) {
          localStorage.setItem("preye.token", data.token);
          gate.hidden = true;
          resolve(true);
          return;
        }
        errorEl.textContent = "Falsches Passwort.";
        errorEl.hidden = false;
        input.select();
      } catch (err) {
        errorEl.textContent = "Fehler: " + (err.message || err);
        errorEl.hidden = false;
      } finally {
        inflight = false;
        submitBtn.disabled = false;
      }
    }
    form.addEventListener("submit", (e) => { e.preventDefault(); attempt(); });
  });
}

// ---------- Toast ----------

let toastTimer = null;
function showToast(msg, kind, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = kind === "error" ? "toast-error" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- Routing ----------

function route() {
  const hash = location.hash || "#/";
  $$(".ev-view").forEach((v) => { v.hidden = true; });
  if (hash === "#/" || hash === "") {
    $("#view-list").hidden = false;
    loadEvents();
  } else if (hash === "#/new") {
    $("#view-new").hidden = false;
    $("#ev-name").focus();
  } else if (hash.startsWith("#/event/")) {
    const id = decodeURIComponent(hash.slice("#/event/".length));
    $("#view-detail").hidden = false;
    loadEventDetail(id);
  } else {
    location.hash = "#/";
  }
}

// ---------- List ----------

async function loadEvents() {
  const list = $("#events-list");
  // Hydrate from cache first so the list is on screen immediately.
  const cached = readCache("events-list");
  if (cached) {
    state.events = cached;
    renderEventsList();
  } else {
    list.innerHTML = "<div class='boar-loader boar-loader--center'>Lade …</div>";
  }
  try {
    const fresh = await fetchJson("events-list");
    state.events = fresh;
    writeCache("events-list", null, fresh);
    renderEventsList();
  } catch (err) {
    if (!cached) {
      list.innerHTML = "";
      showToast("Fehler beim Laden: " + err.message, "error");
    }
  }
}

// One of four hand-drawn animals per event, picked deterministically from
// the event id so the same card always shows the same animal across reloads.
const EVENT_ANIMALS = ["boar", "stag", "roebuck", "fallow"];
function pickEventAnimal(id) {
  const s = String(id || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return EVENT_ANIMALS[Math.abs(h) % EVENT_ANIMALS.length];
}

function renderEventsList() {
  const list = $("#events-list");
  $("#events-empty").hidden = state.events.length > 0;
  if (!state.events.length) { list.innerHTML = ""; return; }
  list.innerHTML = state.events.map((ev) => {
    const dateStr = formatDate(ev.date);
    const s = ev.stats || { invited: 0, accepted: 0, declined: 0, pending: 0 };
    const animal = pickEventAnimal(ev.id);
    return `
      <div class="event-card-wrap">
        <a class="event-card" href="#/event/${encodeURIComponent(ev.id)}">
          <img class="event-card-icon" src="event-icons/${animal}.png" alt="" loading="lazy" />
          <div class="event-card-content">
            <div class="event-card-head">
              <h3>${escapeHtml(ev.name)}</h3>
              <span class="event-date">${escapeHtml(dateStr)}</span>
            </div>
            ${ev.treffpunkt ? `<p class="event-meta">${escapeHtml(ev.treffpunkt)}${ev.treff_time ? " · " + escapeHtml(ev.treff_time) : ""}</p>` : ""}
            <div class="event-stats">
              <span class="stat stat-invited">${s.invited} eingeladen</span>
              <span class="stat stat-accepted">${s.accepted} ✓</span>
              <span class="stat stat-declined">${s.declined} ✗</span>
              <span class="stat stat-pending">${s.pending} offen</span>
            </div>
          </div>
        </a>
        <button class="event-delete-btn" data-eid="${escapeHtml(ev.id)}" type="button" aria-label="Veranstaltung löschen" title="Veranstaltung löschen">×</button>
      </div>
    `;
  }).join("");
}

async function deleteEvent(id) {
  const ev = state.events.find((e) => e.id === id);
  const name = ev ? ev.name : "diese Veranstaltung";
  if (!confirm("„" + name + "“ wirklich löschen? Alle Einladungen, RSVPs und Squads werden mit gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.")) return;
  try {
    await postJson({ action: "event-delete", id });
    invalidateCache("events-list");
    invalidateCache("event-detail", { id });
    showToast("Veranstaltung gelöscht ✓");
    await loadEvents();
  } catch (err) {
    showToast(err.message || "Fehler beim Löschen", "error");
  }
}

function formatDate(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// ---------- Create ----------

async function submitNewEvent(e) {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const teilgebiet = $$("input[name=teilgebiet]:checked").map((c) => c.value).join(", ");
    const nachsuchenfuehrer = $$("#nsf-rows .nsf-row").map((row) => ({
      name: row.querySelector(".nsf-name").value.trim(),
      phone: row.querySelector(".nsf-phone").value.trim(),
    })).filter((p) => p.name || p.phone);
    const body = {
      action: "event-create",
      name: $("#ev-name").value.trim(),
      date: $("#ev-date").value,
      teilgebiet,
      rsvp_deadline: $("#ev-rsvp-deadline").value,
      treffpunkt: $("#ev-treffpunkt").value.trim(),
      treff_time: $("#ev-treff-time").value,
      start_time: $("#ev-start-time").value,
      end_time: $("#ev-end-time").value,
      briefing: $("#ev-briefing").value.trim(),
      organizer: $("#ev-organizer").value.trim(),
      vet_name: $("#ev-vet-name").value.trim(),
      vet_phone: $("#ev-vet-phone").value.trim(),
      coordinator_name: $("#ev-coordinator-name").value.trim(),
      coordinator_phone: $("#ev-coordinator-phone").value.trim(),
      nachsuchenfuehrer,
    };
    const data = await postJson(body);
    invalidateCache("events-list");
    e.target.reset();
    $("#nsf-rows").innerHTML = "";
    showToast("Veranstaltung angelegt ✓");
    location.hash = "#/event/" + encodeURIComponent(data.id);
  } catch (err) {
    showToast(err.message || "Fehler", "error");
  } finally {
    btn.disabled = false;
  }
}

// ---------- Detail ----------

async function loadEventDetail(id) {
  const cached = readCache("event-detail", { id });
  if (cached) {
    state.currentEvent = cached;
    renderEventDetail();
  } else {
    $("#event-header").innerHTML = "<div class='boar-loader boar-loader--center'>Lade …</div>";
    $("#hunters-list").innerHTML = "";
  }
  try {
    const fresh = await fetchJson("event-detail", { id });
    state.currentEvent = fresh;
    writeCache("event-detail", { id }, fresh);
    renderEventDetail();
  } catch (err) {
    if (!cached) {
      $("#event-header").innerHTML = "<p class='ev-error'>Fehler: " + escapeHtml(err.message) + "</p>";
    }
  }
}

function renderEventDetail() {
  const { event, hunters } = state.currentEvent;
  const header = $("#event-header");
  const dateLong = formatLongDate(event.date);
  const dateShort = formatDate(event.date);
  // Singular/plural just like the email — "Teilgebiet" vs "Teilgebiete".
  const teilgebietParts = (event.teilgebiet || "").split(/\s*,\s*/).filter(Boolean);
  const teilgebietLabel = teilgebietParts.length > 1 ? "Teilgebiete" : "Teilgebiet";
  const teilgebietValue = teilgebietParts.join(", ");
  const infoRows = [];
  if (event.treffpunkt) infoRows.push({ label: "Treffpunkt", value: event.treffpunkt });
  if (teilgebietValue) infoRows.push({ label: teilgebietLabel, value: teilgebietValue });
  if (event.rsvp_deadline) infoRows.push({ label: "Anmeldeschluss", value: formatLongDate(event.rsvp_deadline) });
  const times = [
    event.treff_time ? { label: "Treff", value: event.treff_time + " Uhr" } : null,
    event.start_time ? { label: "Beginn", value: event.start_time + " Uhr" } : null,
    event.end_time ? { label: "Ende", value: event.end_time + " Uhr" } : null,
  ].filter(Boolean);
  header.innerHTML = `
    <div class="ev-hero">
      <h2 class="ev-hero-title">${escapeHtml(event.name)}</h2>
      ${dateLong ? `<p class="ev-hero-date">${escapeHtml(dateLong)}</p>` : ""}
    </div>
    ${infoRows.length ? `
      <div class="ev-info-list">
        ${infoRows.map((r) => `
          <div class="ev-info-row">
            <span class="ev-info-label">${escapeHtml(r.label)}</span>
            <span class="ev-info-value">${escapeHtml(r.value)}</span>
          </div>
        `).join("")}
      </div>
    ` : ""}
    ${times.length ? `
      <div class="ev-times-strip">
        ${times.map((t) => `
          <div class="ev-time">
            <span class="ev-time-label">${escapeHtml(t.label)}</span>
            <span class="ev-time-value">${escapeHtml(t.value.replace(" Uhr", ""))}</span>
          </div>
        `).join("")}
      </div>
    ` : ""}
    ${event.briefing ? `<p class="ev-briefing">${escapeHtml(event.briefing)}</p>` : ""}
  `;
  renderContactsBlock(event);
  renderHuntersList(hunters);
  if (state.postsLoaded) renderSquads();
}

function formatLongDate(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function renderContactsBlock(event) {
  const el = $("#event-contacts");
  const lines = [];
  const vet = [event.vet_name, event.vet_phone].filter(Boolean).join(" — ");
  const coord = [event.coordinator_name, event.coordinator_phone].filter(Boolean).join(" — ");
  if (vet) lines.push(`<p><span class="ev-contact-label">Tierarzt:</span> ${escapeHtml(vet)}</p>`);
  if (coord) lines.push(`<p><span class="ev-contact-label">Nachsuchen-Koordinator:</span> ${escapeHtml(coord)}</p>`);
  const nsf = Array.isArray(event.nachsuchenfuehrer) ? event.nachsuchenfuehrer.filter((p) => p.name || p.phone) : [];
  if (nsf.length) {
    const items = nsf.map((p) => `<li>${escapeHtml([p.name, p.phone].filter(Boolean).join(" — "))}</li>`).join("");
    lines.push(`<p class="ev-contact-label">Nachsuchenführer:</p><ul class="ev-nsf-list">${items}</ul>`);
  }
  if (!lines.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<h3 class="ev-contacts-title">Kontakte <span class="muted">(für die schriftliche Einladung)</span></h3>${lines.join("")}`;
}

function renderHuntersList(hunters) {
  const list = $("#hunters-list");
  if (!hunters.length) {
    list.innerHTML = "<p class='empty-msg'>Noch keine Jäger hinzugefügt.</p>";
    updateInviteStatus();
    return;
  }
  list.innerHTML = hunters.map((h) => {
    const baseLabel = {
      accepted: "Zugesagt ✓",
      declined: "Abgesagt ✗",
      invited: "Eingeladen ⋯",
      pending: "Offen",
    }[h.status] || h.status;
    const statusLabel = h.status === "accepted" && h.role
      ? h.role + " ✓"
      : baseLabel;
    const dogsText = (h.status === "accepted" && Array.isArray(h.dogs) && h.dogs.length)
      ? "Hunde: " + h.dogs.map((d) => d.count + "× " + d.breed).join(", ")
      : "";
    const flag = h.language === "en" ? "🇬🇧" : "🇩🇪";
    return `
      <div class="hunter-row hunter-${escapeHtml(h.status || "pending")}">
        <span class="hunter-flag" title="${h.language === "en" ? "English" : "Deutsch"}">${flag}</span>
        <div class="hunter-main">
          <strong>${escapeHtml(h.hunter)}</strong>
          <span class="hunter-email">${escapeHtml(h.email || "—")}</span>
          ${dogsText ? `<span class="hunter-dogs">${escapeHtml(dogsText)}</span>` : ""}
        </div>
        <span class="hunter-status">${escapeHtml(statusLabel)}</span>
        <button class="link-btn hunter-remove" data-hid="${escapeHtml(h.id)}" title="Entfernen">×</button>
      </div>
    `;
  }).join("");
  updateInviteStatus();
}

function updateInviteStatus() {
  const status = $("#invite-status");
  const hunters = state.currentEvent?.hunters || [];
  const unsent = hunters.filter((h) => h.email && !h.invited_at).length;
  const total = hunters.filter((h) => h.email).length;
  if (!total) {
    status.textContent = "";
  } else if (unsent === 0) {
    status.textContent = `Alle ${total} Einladungen versendet.`;
  } else {
    status.textContent = `${unsent} ausstehend (${total - unsent} bereits versendet).`;
  }
}

async function addHunter(e) {
  e.preventDefault();
  if (!state.currentEvent) return;
  const name = $("#add-hunter-name").value.trim();
  const email = $("#add-hunter-email").value.trim();
  const language = $("#add-hunter-lang").value || "de";
  if (!name) return;
  if (!email) {
    showToast("E-Mail erforderlich", "error");
    return;
  }
  try {
    await postJson({
      action: "event-hunter-add",
      event_id: state.currentEvent.event.id,
      hunter: name,
      email: email,
      language: language,
    });
    invalidateCache("event-detail", { id: state.currentEvent.event.id });
    invalidateCache("events-list");
    invalidateCache("address-book");
    $("#add-hunter-name").value = "";
    $("#add-hunter-email").value = "";
    $("#add-hunter-lang").value = "de";
    // Reflect locally so the datalist updates without a refetch.
    const i = state.addressBook.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) state.addressBook[i] = { name, email, language };
    else state.addressBook.push({ name, email, language });
    refreshAddressBookList();
    await loadEventDetail(state.currentEvent.event.id);
    $("#add-hunter-name").focus();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function removeHunter(huntId) {
  if (!huntId) return;
  if (!confirm("Diesen Jäger aus der Liste entfernen?")) return;
  try {
    await postJson({ action: "event-hunter-remove", id: huntId });
    invalidateCache("event-detail", { id: state.currentEvent.event.id });
    invalidateCache("events-list");
    await loadEventDetail(state.currentEvent.event.id);
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Two-step invitation flow:
//   1. openInvitePreview — load BOTH the German and English rendered templates
//      and let the organizer edit subject + body in either language via a tab.
//   2. sendInvites — POST both versions; backend picks per hunter based on
//      that hunter's language preference and swaps {link} for their magic URL.
let invitePreview = null; // { de: {subject, body}, en: {...}, activeLang }

async function openInvitePreview() {
  if (!state.currentEvent) return;
  const btn = $("#open-invite-preview");
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "Lade …";
  try {
    const eid = state.currentEvent.event.id;
    const [de, en] = await Promise.all([
      fetchJson("invite-preview", { event_id: eid, language: "de" }),
      fetchJson("invite-preview", { event_id: eid, language: "en" }),
    ]);
    if (de.error) throw new Error(de.error);
    if (en.error) throw new Error(en.error);
    invitePreview = {
      de: { subject: de.subject || "", body: de.body || "" },
      en: { subject: en.subject || "", body: en.body || "" },
      activeLang: "de",
    };
    showInviteLang("de", /* skipSave */ true);
    updateInviteRecipientsLine();
    $("#invite-backdrop").hidden = false;
    $("#invite-modal").hidden = false;
  } catch (err) {
    showToast(err.message || "Fehler", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function showInviteLang(lang, skipSave) {
  if (!invitePreview) return;
  if (!skipSave && invitePreview.activeLang && invitePreview[invitePreview.activeLang]) {
    invitePreview[invitePreview.activeLang].subject = $("#invite-subject").value;
    invitePreview[invitePreview.activeLang].body = $("#invite-body").value;
  }
  invitePreview.activeLang = lang;
  $("#invite-subject").value = invitePreview[lang].subject;
  $("#invite-body").value = invitePreview[lang].body;
  $$(".invite-lang-tab").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
}

function updateInviteRecipientsLine() {
  const hunters = state.currentEvent?.hunters || [];
  const sendable = hunters.filter((h) => h.email && !h.invited_at);
  const total = hunters.filter((h) => h.email).length;
  const sent = total - sendable.length;
  let line;
  if (!total) {
    line = "Noch keine Jäger mit E-Mail — versenden ist erst möglich, wenn welche eingetragen sind.";
  } else if (!sendable.length) {
    line = `Alle ${total} Einladungen wurden bereits versendet — Senden überträgt keine neuen E-Mails.`;
  } else {
    const counts = { de: 0, en: 0 };
    sendable.forEach((h) => { counts[h.language === "en" ? "en" : "de"]++; });
    const parts = [];
    if (counts.de) parts.push(`${counts.de} 🇩🇪`);
    if (counts.en) parts.push(`${counts.en} 🇬🇧`);
    line = `Wird an ${sendable.length} Jäger versendet (${parts.join(" · ")})` +
           (sent ? `, ${sent} bereits versendet — werden übersprungen.` : ".");
  }
  $("#invite-recipients").textContent = line;
}

function closeInvitePreview() {
  $("#invite-modal").hidden = true;
  $("#invite-backdrop").hidden = true;
}

async function sendInvites() {
  if (!state.currentEvent || !invitePreview) return;
  // Capture whatever's in the textarea for the currently-visible language.
  invitePreview[invitePreview.activeLang].subject = $("#invite-subject").value;
  invitePreview[invitePreview.activeLang].body = $("#invite-body").value;
  const btn = $("#send-invites-btn");
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "Sende …";
  try {
    const baseUrl = location.href.replace(/[^/]*$/, "");
    const data = await postJson({
      action: "event-invites-send",
      event_id: state.currentEvent.event.id,
      base_url: baseUrl,
      only_unsent: true,
      subject_de: invitePreview.de.subject,
      body_text_de: invitePreview.de.body,
      subject_en: invitePreview.en.subject,
      body_text_en: invitePreview.en.body,
    });
    invalidateCache("event-detail", { id: state.currentEvent.event.id });
    invalidateCache("events-list");
    if (data.errors && data.errors.length) {
      const failed = data.errors.map((e) => e.hunter).join(", ");
      showToast(`Versendet: ${data.sent}, Fehler bei: ${failed}`, "error", 6000);
    } else if (data.sent === 0) {
      showToast("Keine ausstehenden Einladungen.");
    } else {
      showToast(`${data.sent} Einladung${data.sent === 1 ? "" : "en"} versendet ✓`);
    }
    closeInvitePreview();
    await loadEventDetail(state.currentEvent.event.id);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

// ---------- CSV import ----------

function parseCsvLine(line, delim) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === delim) { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  // Detect delimiter: comma, semicolon (German Excel default), or tab.
  let delim = ",";
  let max = 0;
  for (const d of [",", ";", "\t"]) {
    const re = new RegExp(d === "\t" ? "\t" : "\\" + d, "g");
    const count = (lines[0].match(re) || []).length;
    if (count > max) { max = count; delim = d; }
  }
  return lines.map((line) => parseCsvLine(line, delim));
}

async function importHuntersFromCsv(file) {
  if (!file || !state.currentEvent) return;
  const text = await file.text();
  const rows = parseCsv(text);
  if (!rows.length) {
    showToast("CSV-Datei ist leer.", "error");
    return;
  }
  // First-row header detection: any of "name" / "mail" / "email" in cells.
  const first = rows[0].map((c) => c.toLowerCase().trim());
  const hasHeader = first.some((c) => c.includes("name") || c.includes("mail"));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  let nameIdx = 0, emailIdx = 1, langIdx = 2;
  if (hasHeader) {
    first.forEach((h, i) => {
      if (h.includes("name") && !h.includes("user")) nameIdx = i;
      else if (h.includes("mail")) emailIdx = i;
      else if (/sprache|language|^lang$/.test(h)) langIdx = i;
    });
  }
  const hunters = dataRows
    .map((row) => ({
      name: (row[nameIdx] || "").trim(),
      email: (row[emailIdx] || "").trim(),
      language: ((row[langIdx] || "de").trim().toLowerCase() === "en" ? "en" : "de"),
    }))
    .filter((h) => h.name && h.email);
  if (!hunters.length) {
    showToast("Keine gültigen Zeilen gefunden — erwartet: Name, E-Mail, (Sprache).", "error", 5000);
    return;
  }
  try {
    const r = await postJson({
      action: "event-hunters-batch-add",
      event_id: state.currentEvent.event.id,
      hunters,
    });
    invalidateCache("event-detail", { id: state.currentEvent.event.id });
    invalidateCache("events-list");
    invalidateCache("address-book");
    const parts = [`${r.added} hinzugefügt`];
    if (r.skipped && r.skipped.length) parts.push(`${r.skipped.length} bereits vorhanden`);
    if (r.errors && r.errors.length) parts.push(`${r.errors.length} Fehler`);
    showToast(parts.join(" · "), r.errors && r.errors.length ? "error" : null, 5000);
    await loadEventDetail(state.currentEvent.event.id);
    await loadAddressBook();
  } catch (err) {
    showToast(err.message || "CSV-Import fehlgeschlagen", "error");
  }
}

// ---------- Address book picker ----------

async function openAddressBookModal() {
  if (!state.currentEvent) return;
  await loadAddressBook();
  const rosterEmails = new Set(
    (state.currentEvent.hunters || []).map((h) => (h.email || "").toLowerCase()).filter(Boolean)
  );
  const list = $("#address-book-list");
  if (!state.addressBook.length) {
    list.innerHTML = "";
    $("#address-book-empty").hidden = false;
  } else {
    $("#address-book-empty").hidden = true;
    // Sort alphabetically by name for predictable browsing.
    const sorted = state.addressBook.slice().sort((a, b) =>
      a.name.localeCompare(b.name, "de", { sensitivity: "base" })
    );
    list.innerHTML = sorted.map((c) => {
      const checked = rosterEmails.has(c.email.toLowerCase()) ? "checked" : "";
      const flag = c.language === "en" ? "🇬🇧" : "🇩🇪";
      return `
        <label class="ab-row">
          <input type="checkbox"
                 data-name="${escapeHtml(c.name)}"
                 data-email="${escapeHtml(c.email)}"
                 data-lang="${escapeHtml(c.language || "de")}"
                 ${checked} />
          <span class="ab-flag" aria-hidden="true">${flag}</span>
          <div class="ab-main">
            <span class="ab-name">${escapeHtml(c.name)}</span>
            <span class="ab-email">${escapeHtml(c.email)}</span>
          </div>
        </label>
      `;
    }).join("");
  }
  $("#address-book-backdrop").hidden = false;
  $("#address-book-modal").hidden = false;
}

function closeAddressBookModal() {
  $("#address-book-modal").hidden = true;
  $("#address-book-backdrop").hidden = true;
}

async function applyAddressBookSelection() {
  if (!state.currentEvent) return;
  const checkboxes = $$("#address-book-list input[type=checkbox]");
  const rosterByEmail = new Map();
  (state.currentEvent.hunters || []).forEach((h) => {
    if (h.email) rosterByEmail.set(h.email.toLowerCase(), h);
  });
  const toAdd = [];
  const toRemoveIds = [];
  checkboxes.forEach((cb) => {
    const email = cb.dataset.email.toLowerCase();
    if (cb.checked && !rosterByEmail.has(email)) {
      toAdd.push({
        name: cb.dataset.name,
        email: cb.dataset.email,
        language: cb.dataset.lang || "de",
      });
    } else if (!cb.checked && rosterByEmail.has(email)) {
      toRemoveIds.push(rosterByEmail.get(email).id);
    }
  });
  if (!toAdd.length && !toRemoveIds.length) {
    closeAddressBookModal();
    return;
  }
  const btn = $("#address-book-apply");
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "Speichere …";
  try {
    for (const id of toRemoveIds) {
      await postJson({ action: "event-hunter-remove", id });
    }
    let added = 0;
    if (toAdd.length) {
      const r = await postJson({
        action: "event-hunters-batch-add",
        event_id: state.currentEvent.event.id,
        hunters: toAdd,
      });
      added = r.added || 0;
    }
    invalidateCache("event-detail", { id: state.currentEvent.event.id });
    invalidateCache("events-list");
    invalidateCache("address-book");
    const parts = [];
    if (added) parts.push(`${added} hinzugefügt`);
    if (toRemoveIds.length) parts.push(`${toRemoveIds.length} entfernt`);
    showToast(parts.join(" · ") || "Keine Änderungen");
    closeAddressBookModal();
    await loadEventDetail(state.currentEvent.event.id);
  } catch (err) {
    showToast(err.message || "Fehler", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

// ---------- Address book ----------

async function loadAddressBook() {
  const cached = readCache("address-book");
  if (cached) {
    state.addressBook = cached;
    refreshAddressBookList();
  }
  try {
    const fresh = await fetchJson("address-book");
    state.addressBook = fresh;
    writeCache("address-book", null, fresh);
    refreshAddressBookList();
  } catch (err) {
    if (!cached) state.addressBook = [];
  }
}

function refreshAddressBookList() {
  const dl = $("#address-book-options");
  if (!dl) return;
  dl.innerHTML = state.addressBook.map((c) =>
    `<option value="${escapeHtml(c.name)}" data-email="${escapeHtml(c.email)}"></option>`
  ).join("");
}

// When the user picks a name from the datalist, autofill the email
// and language preference from the address book.
function onHunterNamePick() {
  const name = $("#add-hunter-name").value.trim();
  const hit = state.addressBook.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!hit) return;
  if (hit.email && !$("#add-hunter-email").value) $("#add-hunter-email").value = hit.email;
  if (hit.language) $("#add-hunter-lang").value = hit.language;
}

// ---------- Tabs ----------

function switchTab(tab) {
  $$(".ev-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#tab-invites").hidden = tab !== "invites";
  $("#tab-squads").hidden = tab !== "squads";
  if (tab === "squads") {
    loadPostsIfNeeded().then(renderSquads);
  }
}

// ---------- Ansteller Runden (squads) ----------
// Each Ansteller Runde = one Ansteller (group leader) + several Schützen,
// each assigned to a Kanzel (from the event's Teilgebiet) or to a
// Klettersitz with coordinates. Only accepted hunters appear in the picker.

async function loadPostsIfNeeded() {
  if (state.postsLoaded) return;
  // The map app caches bootstrap under the same key — re-use it.
  const cached = readCache("bootstrap");
  if (cached && Array.isArray(cached.posts)) {
    state.posts = cached.posts;
    state.postsLoaded = true;
    return;
  }
  try {
    const data = await fetchJson("bootstrap");
    state.posts = Array.isArray(data.posts) ? data.posts : [];
    state.postsLoaded = true;
    writeCache("bootstrap", null, data);
  } catch (err) {
    state.posts = [];
    state.postsLoaded = true; // avoid retry loop
  }
}

function getAcceptedHunters() {
  return (state.currentEvent?.hunters || []).filter((h) => h.status === "accepted");
}

// Filter posts to only those whose `area` matches one of the event's
// Teilgebiete. For NPA-Müritz the corresponding areas (Babke, Langenhagen,
// Schwarzenhof) currently have no posts, so this naturally returns empty
// and forces Klettersitz with manual coordinates.
function getKanzelnForEvent() {
  if (!state.currentEvent) return [];
  const teilgebiete = new Set(
    (state.currentEvent.event.teilgebiet || "").split(/\s*,\s*/).filter(Boolean)
  );
  return state.posts.filter((p) => teilgebiete.has(p.area))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

function nextAnstellerRundeName() {
  const existing = state.currentEvent?.squads || [];
  // Find the highest "Ansteller Runde N" and add 1.
  let max = 0;
  for (const s of existing) {
    const m = /Ansteller Runde\s+(\d+)/i.exec(s.name || "");
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "Ansteller Runde " + (max + 1);
}

function renderSquads() {
  const wrap = $("#squads-list");
  const empty = $("#squads-empty");
  const hint = $("#squads-hint");
  const squads = state.currentEvent?.squads || [];
  if (!squads.length) {
    wrap.innerHTML = "";
    empty.hidden = false;
  } else {
    empty.hidden = true;
    wrap.innerHTML = squads.map((s) => renderSquadCard(s)).join("");
    squads.forEach((s) => wireSquadCard(document.getElementById("squad-" + s.id), s));
  }
  // Helpful note if no Kanzeln are available (NPA-Müritz or no Teilgebiet picked).
  const kanzeln = getKanzelnForEvent();
  if (state.posts.length && !kanzeln.length) {
    hint.textContent = "Keine Kanzeln im gewählten Teilgebiet hinterlegt — bitte „Klettersitz" mit Koordinaten verwenden.";
  } else {
    hint.textContent = "";
  }
}

function renderSquadCard(squad) {
  const accepted = getAcceptedHunters();
  const anstellerOptions = anstellerSelectHtml(accepted, squad.ansteller);
  const positionsHtml = (squad.positions || []).map((p, i) =>
    renderSchuetzeRow(p, i, accepted)
  ).join("");
  return `
    <article class="squad-card" id="squad-${escapeHtml(squad.id)}" data-sid="${escapeHtml(squad.id)}">
      <header class="squad-head">
        <h3 class="squad-name">${escapeHtml(squad.name || "Ansteller Runde")}</h3>
        <button class="link-btn squad-delete" type="button" aria-label="Runde löschen" title="Runde löschen">×</button>
      </header>
      <label class="squad-field">
        <span class="squad-field-label">Ansteller</span>
        <select class="squad-ansteller">${anstellerOptions}</select>
      </label>
      <p class="squad-field-label squad-schuetzen-title">Schützen</p>
      <div class="schuetzen-list">${positionsHtml}</div>
      <button class="ghost-btn squad-add-schuetze" type="button">+ Schütze hinzufügen</button>
      <label class="squad-field">
        <span class="squad-field-label">Bemerkung <span class="muted">(optional)</span></span>
        <textarea class="squad-briefing" rows="2">${escapeHtml(squad.briefing || "")}</textarea>
      </label>
      <div class="squad-actions">
        <button class="primary-btn small squad-save" type="button">Speichern</button>
        <span class="squad-status muted"></span>
      </div>
    </article>
  `;
}

function anstellerSelectHtml(accepted, currentValue) {
  const opts = accepted.map((h) => {
    const sel = (h.hunter === currentValue) ? " selected" : "";
    return `<option value="${escapeHtml(h.hunter)}"${sel}>${escapeHtml(h.hunter)}</option>`;
  }).join("");
  return `<option value="">— Ansteller wählen —</option>${opts}`;
}

function hunterSelectHtml(accepted, currentValue) {
  const opts = accepted.map((h) => {
    const sel = (h.hunter === currentValue) ? " selected" : "";
    return `<option value="${escapeHtml(h.hunter)}"${sel}>${escapeHtml(h.hunter)}</option>`;
  }).join("");
  return `<option value="">— Jäger wählen —</option>${opts}`;
}

function positionSelectHtml(currentPosition) {
  const kanzeln = getKanzelnForEvent();
  const currentValue = currentPosition && currentPosition.type === "kanzel"
    ? "kanzel:" + (currentPosition.post_id || "")
    : currentPosition && currentPosition.type === "klettersitz"
      ? "klettersitz" : "";
  const groupOptions = kanzeln.map((p) => {
    const v = "kanzel:" + p.id;
    const sel = (v === currentValue) ? " selected" : "";
    return `<option value="${escapeHtml(v)}"${sel}>${escapeHtml(p.name)} (${escapeHtml(p.area)})</option>`;
  }).join("");
  const selKlettersitz = (currentValue === "klettersitz") ? " selected" : "";
  return `
    <option value="">— Position wählen —</option>
    ${kanzeln.length ? `<optgroup label="Kanzel">${groupOptions}</optgroup>` : ""}
    <option value="klettersitz"${selKlettersitz}>Klettersitz (Koordinaten)</option>
  `;
}

function renderSchuetzeRow(pos, idx, accepted) {
  const isKlettersitz = pos && pos.type === "klettersitz";
  const lat = pos && pos.lat !== undefined && pos.lat !== "" ? Number(pos.lat).toFixed(6) : "";
  const lng = pos && pos.lng !== undefined && pos.lng !== "" ? Number(pos.lng).toFixed(6) : "";
  return `
    <div class="schuetze-row" data-idx="${idx}">
      <div class="sr-line sr-hunter-line">
        <span class="sr-num">${idx + 1}.</span>
        <select class="sr-hunter">${hunterSelectHtml(accepted, pos && pos.hunter)}</select>
        <button class="link-btn sr-remove" type="button" aria-label="Schützen entfernen">×</button>
      </div>
      <div class="sr-line sr-position-line">
        <select class="sr-position">${positionSelectHtml(pos)}</select>
      </div>
      <div class="sr-coords" ${isKlettersitz ? "" : "hidden"}>
        <div class="sr-coords-grid">
          <input type="number" class="sr-lat" step="0.000001" inputmode="decimal" value="${lat}" placeholder="Breitengrad" />
          <input type="number" class="sr-lng" step="0.000001" inputmode="decimal" value="${lng}" placeholder="Längengrad" />
        </div>
        <div class="sr-coords-grid">
          <input type="text" class="sr-label" value="${escapeHtml(pos && pos.label || "")}" maxlength="60" placeholder="Bezeichnung (optional)" />
          <button class="ghost-btn sr-here" type="button" title="Aktuelle Position">📍</button>
        </div>
      </div>
    </div>
  `;
}

function wireSquadCard(card, squad) {
  if (!card) return;
  // Delete the whole Runde.
  card.querySelector(".squad-delete").addEventListener("click", async () => {
    if (!confirm(`„${squad.name}" wirklich löschen?`)) return;
    try {
      await postJson({ action: "event-squad-delete", id: squad.id });
      invalidateCache("event-detail", { id: state.currentEvent.event.id });
      await loadEventDetail(state.currentEvent.event.id);
    } catch (err) {
      showToast(err.message || "Fehler", "error");
    }
  });
  // Add a new Schütze row.
  card.querySelector(".squad-add-schuetze").addEventListener("click", () => {
    const list = card.querySelector(".schuetzen-list");
    const idx = list.querySelectorAll(".schuetze-row").length;
    const accepted = getAcceptedHunters();
    list.insertAdjacentHTML("beforeend", renderSchuetzeRow(null, idx, accepted));
    wireSchuetzeRow(list.lastElementChild);
  });
  // Wire existing rows.
  card.querySelectorAll(".schuetze-row").forEach(wireSchuetzeRow);
  // Save.
  card.querySelector(".squad-save").addEventListener("click", () => saveSquadCard(card, squad));
}

function wireSchuetzeRow(row) {
  if (!row) return;
  row.querySelector(".sr-remove").addEventListener("click", () => {
    row.remove();
  });
  const posSel = row.querySelector(".sr-position");
  const coords = row.querySelector(".sr-coords");
  posSel.addEventListener("change", () => {
    coords.hidden = posSel.value !== "klettersitz";
  });
  const here = row.querySelector(".sr-here");
  if (here) {
    here.addEventListener("click", () => {
      if (!navigator.geolocation) { showToast("Standort nicht verfügbar", "error"); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        row.querySelector(".sr-lat").value = pos.coords.latitude.toFixed(6);
        row.querySelector(".sr-lng").value = pos.coords.longitude.toFixed(6);
        showToast("Position übernommen");
      }, (err) => showToast("Standort: " + err.message, "error", 4000),
      { enableHighAccuracy: true, timeout: 8000 });
    });
  }
}

function collectPositions(card) {
  const rows = card.querySelectorAll(".schuetze-row");
  const positions = [];
  rows.forEach((row) => {
    const hunter = row.querySelector(".sr-hunter").value.trim();
    if (!hunter) return; // skip empty rows
    const posVal = row.querySelector(".sr-position").value;
    if (posVal === "klettersitz") {
      const lat = row.querySelector(".sr-lat").value.trim();
      const lng = row.querySelector(".sr-lng").value.trim();
      const label = row.querySelector(".sr-label").value.trim();
      positions.push({
        hunter,
        type: "klettersitz",
        lat: lat ? Number(lat) : "",
        lng: lng ? Number(lng) : "",
        label,
      });
    } else if (posVal && posVal.startsWith("kanzel:")) {
      const post_id = posVal.slice("kanzel:".length);
      const post = state.posts.find((p) => p.id === post_id);
      positions.push({
        hunter,
        type: "kanzel",
        post_id,
        post_name: post ? post.name : "",
      });
    } else {
      // No position picked yet — keep the hunter so the row is preserved.
      positions.push({ hunter, type: "kanzel", post_id: "", post_name: "" });
    }
  });
  return positions;
}

async function saveSquadCard(card, squad) {
  const btn = card.querySelector(".squad-save");
  const status = card.querySelector(".squad-status");
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "Speichere …";
  status.textContent = "";
  try {
    const positions = collectPositions(card);
    const ansteller = card.querySelector(".squad-ansteller").value.trim();
    const briefing = card.querySelector(".squad-briefing").value.trim();
    await postJson({
      action: "event-squad-save",
      id: squad.id,
      event_id: state.currentEvent.event.id,
      name: squad.name,
      ansteller,
      positions,
      briefing,
    });
    invalidateCache("event-detail", { id: state.currentEvent.event.id });
    status.textContent = "Gespeichert ✓";
    setTimeout(() => { status.textContent = ""; }, 2500);
    // Update local state without re-rendering the whole list (preserves
    // user's place in the form if they edit multiple cards).
    const squads = state.currentEvent.squads;
    const idx = squads.findIndex((x) => x.id === squad.id);
    if (idx >= 0) squads[idx] = { ...squad, ansteller, positions, briefing };
  } catch (err) {
    showToast(err.message || "Fehler beim Speichern", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function addSquad() {
  if (!state.currentEvent) return;
  await loadPostsIfNeeded();
  const accepted = getAcceptedHunters();
  if (!accepted.length) {
    showToast("Erst Zusagen einsammeln — Ansteller Runden brauchen mind. einen zugesagten Jäger.", "error", 5000);
    return;
  }
  try {
    const r = await postJson({
      action: "event-squad-save",
      event_id: state.currentEvent.event.id,
      name: nextAnstellerRundeName(),
      ansteller: "",
      positions: [],
      briefing: "",
    });
    invalidateCache("event-detail", { id: state.currentEvent.event.id });
    await loadEventDetail(state.currentEvent.event.id);
    // Re-show the squads tab and scroll the new card into view.
    switchTab("squads");
    requestAnimationFrame(() => {
      const card = document.getElementById("squad-" + r.id);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  } catch (err) {
    showToast(err.message || "Fehler", "error");
  }
}

// ---------- Wiring ----------

function addNsfRow(name, phone) {
  const row = document.createElement("div");
  row.className = "nsf-row";
  row.innerHTML =
    `<input type="text" class="nsf-name" placeholder="Name" value="${escapeHtml(name || "")}" autocomplete="off" />` +
    `<input type="tel"  class="nsf-phone" placeholder="Mobil" inputmode="tel" value="${escapeHtml(phone || "")}" autocomplete="off" />` +
    `<button type="button" class="nsf-remove" aria-label="Entfernen">×</button>`;
  row.querySelector(".nsf-remove").addEventListener("click", () => row.remove());
  $("#nsf-rows").appendChild(row);
}

function wireUi() {
  $("#new-event-btn").addEventListener("click", () => { location.hash = "#/new"; });
  $("#new-event-form").addEventListener("submit", submitNewEvent);
  $("#new-event-cancel").addEventListener("click", () => { location.hash = "#/"; });
  $("#back-to-list").addEventListener("click", () => { location.hash = "#/"; });
  $("#add-hunter-form").addEventListener("submit", addHunter);
  $("#add-hunter-name").addEventListener("change", onHunterNamePick);

  // CSV import — wire the hidden file input via a visible toolbar button.
  $("#open-csv-upload").addEventListener("click", () => $("#csv-input").click());
  $("#csv-input").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (file) await importHuntersFromCsv(file);
  });

  // Address book picker.
  $("#open-address-book").addEventListener("click", openAddressBookModal);
  $("#address-book-close").addEventListener("click", closeAddressBookModal);
  $("#address-book-cancel").addEventListener("click", closeAddressBookModal);
  $("#address-book-backdrop").addEventListener("click", closeAddressBookModal);
  $("#address-book-apply").addEventListener("click", applyAddressBookSelection);

  $("#open-invite-preview").addEventListener("click", openInvitePreview);
  $("#send-invites-btn").addEventListener("click", sendInvites);
  $("#invite-close").addEventListener("click", closeInvitePreview);
  $("#invite-cancel").addEventListener("click", closeInvitePreview);
  $("#invite-backdrop").addEventListener("click", closeInvitePreview);
  $$(".invite-lang-tab").forEach((b) => {
    b.addEventListener("click", () => showInviteLang(b.dataset.lang));
  });
  $("#new-squad-btn").addEventListener("click", addSquad);
  $("#ev-nsf-add").addEventListener("click", () => addNsfRow());
  $("#hunters-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".hunter-remove");
    if (btn) removeHunter(btn.dataset.hid);
  });
  $("#events-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".event-delete-btn");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      deleteEvent(btn.dataset.eid);
    }
  });
  $$(".ev-tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  window.addEventListener("hashchange", route);
}

// ---------- Main ----------

async function main() {
  if (!cfg.APPS_SCRIPT_URL) {
    document.body.innerHTML = "<p style='padding:24px'>config.js fehlt — Pages-Deployment prüfen.</p>";
    return;
  }
  if (!(await passGate())) return;
  wireUi();
  await loadAddressBook();
  route();
}

main();

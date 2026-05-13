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
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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
  list.innerHTML = "<p class='ev-loading'>Lade …</p>";
  try {
    state.events = await fetchJson("events-list");
    renderEventsList();
  } catch (err) {
    list.innerHTML = "";
    showToast("Fehler beim Laden: " + err.message, "error");
  }
}

function renderEventsList() {
  const list = $("#events-list");
  $("#events-empty").hidden = state.events.length > 0;
  if (!state.events.length) { list.innerHTML = ""; return; }
  list.innerHTML = state.events.map((ev) => {
    const dateStr = formatDate(ev.date);
    const s = ev.stats || { invited: 0, accepted: 0, declined: 0, pending: 0 };
    return `
      <a class="event-card" href="#/event/${encodeURIComponent(ev.id)}">
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
      </a>
    `;
  }).join("");
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
    const body = {
      action: "event-create",
      name: $("#ev-name").value.trim(),
      date: $("#ev-date").value,
      teilgebiet: $("#ev-teilgebiet").value.trim(),
      rsvp_deadline: $("#ev-rsvp-deadline").value,
      treffpunkt: $("#ev-treffpunkt").value.trim(),
      treff_time: $("#ev-treff-time").value,
      start_time: $("#ev-start-time").value,
      end_time: $("#ev-end-time").value,
      briefing: $("#ev-briefing").value.trim(),
      organizer: $("#ev-organizer").value.trim(),
    };
    const data = await postJson(body);
    e.target.reset();
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
  $("#event-header").innerHTML = "<p class='ev-loading'>Lade …</p>";
  $("#hunters-list").innerHTML = "";
  try {
    state.currentEvent = await fetchJson("event-detail", { id });
    renderEventDetail();
  } catch (err) {
    $("#event-header").innerHTML = "<p class='ev-error'>Fehler: " + escapeHtml(err.message) + "</p>";
  }
}

function renderEventDetail() {
  const { event, hunters } = state.currentEvent;
  const header = $("#event-header");
  const dateStr = formatDate(event.date);
  const meta = [
    event.treff_time ? `Treff ${event.treff_time}` : "",
    event.start_time ? `Beginn ${event.start_time}` : "",
    event.end_time ? `Ende ${event.end_time}` : "",
  ].filter(Boolean).join(" · ");
  const subline2 = [
    event.teilgebiet ? "Teilgebiet " + event.teilgebiet : "",
    event.rsvp_deadline ? "Anmeldeschluss " + formatDate(event.rsvp_deadline) : "",
  ].filter(Boolean).join(" · ");
  header.innerHTML = `
    <h2 class="ev-title">${escapeHtml(event.name)}</h2>
    <p class="ev-subline">${escapeHtml(dateStr)}${event.treffpunkt ? " · " + escapeHtml(event.treffpunkt) : ""}</p>
    ${subline2 ? `<p class="ev-subline">${escapeHtml(subline2)}</p>` : ""}
    ${meta ? `<p class="ev-subline ev-times">${escapeHtml(meta)}</p>` : ""}
    ${event.briefing ? `<p class="ev-briefing">${escapeHtml(event.briefing)}</p>` : ""}
  `;
  renderHuntersList(hunters);
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
    return `
      <div class="hunter-row hunter-${escapeHtml(h.status || "pending")}">
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
  if (!name) return;
  try {
    await postJson({
      action: "event-hunter-add",
      event_id: state.currentEvent.event.id,
      hunter: name,
      email: email,
    });
    $("#add-hunter-name").value = "";
    $("#add-hunter-email").value = "";
    if (email) state.addressBook.push({ name, email });
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
    await loadEventDetail(state.currentEvent.event.id);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function sendInvites() {
  if (!state.currentEvent) return;
  const btn = $("#send-invites-btn");
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "Sende …";
  try {
    // base_url = the directory holding events.html (and rsvp.html).
    const baseUrl = location.href.replace(/[^/]*$/, "");
    const data = await postJson({
      action: "event-invites-send",
      event_id: state.currentEvent.event.id,
      base_url: baseUrl,
      only_unsent: true,
    });
    if (data.errors && data.errors.length) {
      const failed = data.errors.map((e) => e.hunter).join(", ");
      showToast(`Versendet: ${data.sent}, Fehler bei: ${failed}`, "error", 6000);
    } else if (data.sent === 0) {
      showToast("Keine ausstehenden Einladungen.");
    } else {
      showToast(`${data.sent} Einladung${data.sent === 1 ? "" : "en"} versendet ✓`);
    }
    await loadEventDetail(state.currentEvent.event.id);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

// ---------- Address book ----------

async function loadAddressBook() {
  try {
    state.addressBook = await fetchJson("address-book");
  } catch (err) {
    state.addressBook = [];
  }
  refreshAddressBookList();
}

function refreshAddressBookList() {
  const dl = $("#address-book-options");
  if (!dl) return;
  dl.innerHTML = state.addressBook.map((c) =>
    `<option value="${escapeHtml(c.name)}" data-email="${escapeHtml(c.email)}"></option>`
  ).join("");
}

// When the user picks a name from the datalist, autofill the email.
function onHunterNamePick() {
  const name = $("#add-hunter-name").value.trim();
  const hit = state.addressBook.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (hit && hit.email && !$("#add-hunter-email").value) {
    $("#add-hunter-email").value = hit.email;
  }
}

// ---------- Tabs ----------

function switchTab(tab) {
  $$(".ev-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#tab-invites").hidden = tab !== "invites";
  $("#tab-squads").hidden = tab !== "squads";
}

// ---------- Wiring ----------

function wireUi() {
  $("#new-event-btn").addEventListener("click", () => { location.hash = "#/new"; });
  $("#new-event-form").addEventListener("submit", submitNewEvent);
  $("#new-event-cancel").addEventListener("click", () => { location.hash = "#/"; });
  $("#back-to-list").addEventListener("click", () => { location.hash = "#/"; });
  $("#add-hunter-form").addEventListener("submit", addHunter);
  $("#add-hunter-name").addEventListener("change", onHunterNamePick);
  $("#send-invites-btn").addEventListener("click", sendInvites);
  $("#hunters-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".hunter-remove");
    if (btn) removeHunter(btn.dataset.hid);
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

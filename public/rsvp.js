// RSVP page — hunters land here via the magic-link in their invitation
// email. Authentication is the per-hunter token from `?t=…` (no password).

const cfg = window.PEENWERDER_CONFIG || {};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Filled from the rsvp-info response (DOG_BREEDS server-side) so the list
// stays in one place. Fallback used only if the fetch fails.
let DOG_BREEDS = ["Sonstige"];
let selectedRole = "";

function escapeText(el, value) { el.textContent = String(value || ""); }

function formatDate(iso) {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function getToken() {
  const params = new URLSearchParams(location.search);
  return (params.get("t") || params.get("token") || "").trim();
}

function setState(msg, kind) {
  const el = $("#rsvp-state");
  el.hidden = !msg;
  el.className = "rsvp-state" + (kind ? " rsvp-state-" + kind : "");
  el.innerHTML = msg ? `<p>${msg}</p>` : "";
}

function showCurrentStatus(status, role, dogs) {
  const el = $("#rsvp-current");
  if (!status || status === "pending" || status === "invited") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (status === "accepted") {
    const dogStr = (dogs && dogs.length)
      ? " (mit " + dogs.map((d) => d.count + "× " + d.breed).join(", ") + ")"
      : "";
    el.className = "rsvp-current rsvp-current-accepted";
    el.textContent = "Aktueller Status: Zugesagt " + (role ? "als " + role + dogStr + " " : "") + "✓ — Du kannst die Antwort jederzeit ändern.";
  } else if (status === "declined") {
    el.className = "rsvp-current rsvp-current-declined";
    el.textContent = "Aktueller Status: Abgesagt ✗ — Du kannst doch zusagen, falls Du es einrichten kannst.";
  } else {
    el.hidden = true;
  }
}

function showMeta(key, value) {
  const row = document.querySelector(`.rsvp-meta-row[data-key="${key}"]`);
  if (!row) return;
  if (!value) { row.hidden = true; return; }
  row.hidden = false;
  const dd = row.querySelector("dd");
  if (dd) dd.textContent = value;
}

async function loadInvite() {
  const token = getToken();
  if (!token) {
    setState("Kein gültiger Einladungs-Link.", "error");
    return;
  }
  if (!cfg.APPS_SCRIPT_URL) {
    setState("Konfiguration fehlt — bitte den Organisator informieren.", "error");
    return;
  }
  try {
    const url = cfg.APPS_SCRIPT_URL + "?action=rsvp-info&token=" + encodeURIComponent(token);
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      setState("Diese Einladung ist nicht (mehr) gültig.", "error");
      return;
    }
    setState("");
    $("#rsvp-card").hidden = false;
    escapeText($("#rsvp-hunter"), data.hunter);
    escapeText($("#rsvp-event-name"), data.event.name);
    showMeta("date", formatDate(data.event.date));
    showMeta("treffpunkt", data.event.treffpunkt);
    showMeta("treff_time", data.event.treff_time ? data.event.treff_time + " Uhr" : "");
    showMeta("start_time", data.event.start_time ? data.event.start_time + " Uhr" : "");
    showMeta("end_time", data.event.end_time ? data.event.end_time + " Uhr" : "");
    if (data.event.briefing) {
      $("#rsvp-briefing").hidden = false;
      $("#rsvp-briefing").textContent = data.event.briefing;
    }
    if (data.event.organizer) {
      $("#rsvp-foot").textContent = "Waidmannsheil! — " + data.event.organizer;
    }
    if (Array.isArray(data.breeds) && data.breeds.length) DOG_BREEDS = data.breeds;
    showCurrentStatus(data.status, data.role, data.dogs);
  } catch (err) {
    setState("Fehler beim Laden der Einladung: " + (err.message || err), "error");
  }
}

function showSection(which) {
  // which: "actions" | "roles" | "dogs"
  $("#rsvp-actions").hidden = which !== "actions";
  $("#rsvp-role-choice").hidden = which !== "roles";
  $("#rsvp-dog-form").hidden = which !== "dogs";
}

function pickRole(role) {
  selectedRole = role;
  // Treiber doesn't bring dogs — go straight to submit.
  if (role === "Treiber") {
    respond("accept", role, []);
    return;
  }
  // Schütze/Standschneller or Hundeführer — show dog form (optional).
  $("#dog-role-label").textContent = role;
  $("#dog-rows").innerHTML = "";
  showSection("dogs");
}

function addDogRow(breed, count) {
  const row = document.createElement("div");
  row.className = "dog-row";
  const opts = DOG_BREEDS.map((b) =>
    `<option${breed === b ? " selected" : ""}>${escapeHtml(b)}</option>`
  ).join("");
  row.innerHTML =
    `<select class="dog-breed" aria-label="Hunderasse">` +
    `<option value="">— Rasse wählen —</option>${opts}</select>` +
    `<input type="number" class="dog-count" min="1" max="10" value="${Number(count) || 1}" aria-label="Anzahl" />` +
    `<button class="dog-remove" type="button" aria-label="Entfernen">×</button>`;
  row.querySelector(".dog-remove").addEventListener("click", () => row.remove());
  $("#dog-rows").appendChild(row);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function collectDogs() {
  return $$(".dog-row").map((row) => {
    const breed = row.querySelector(".dog-breed").value.trim();
    const count = Math.max(1, Math.min(10, parseInt(row.querySelector(".dog-count").value, 10) || 1));
    return breed ? { breed, count } : null;
  }).filter(Boolean);
}

async function respond(choice, role, dogs) {
  const token = getToken();
  if (!token) return;
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const payload = { action: "rsvp-respond", token, choice };
    if (role) payload.role = role;
    if (dogs && dogs.length) payload.dogs = dogs;
    const res = await fetch(cfg.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    let msg;
    if (choice === "accept") {
      const dogStr = (dogs && dogs.length)
        ? " mit " + dogs.map((d) => d.count + "× " + d.breed).join(", ")
        : "";
      msg = "Danke! Deine Zusage als " + (role || "Teilnehmer") + dogStr + " ist registriert ✓";
    } else {
      msg = "Schade — die Absage ist registriert.";
    }
    $("#rsvp-card").hidden = true;
    setState(msg, choice === "accept" ? "accepted" : "declined");
  } catch (err) {
    buttons.forEach((b) => { b.disabled = false; });
    setState("Fehler: " + (err.message || err), "error");
  }
}

$("#rsvp-accept").addEventListener("click", () => showSection("roles"));
$("#rsvp-decline").addEventListener("click", () => respond("decline"));
$("#rsvp-role-back").addEventListener("click", () => showSection("actions"));
$("#dog-back").addEventListener("click", () => showSection("roles"));
$("#dog-add").addEventListener("click", () => addDogRow());
$("#dog-submit").addEventListener("click", () => respond("accept", selectedRole, collectDogs()));
$$(".role-btn").forEach((btn) => {
  btn.addEventListener("click", () => pickRole(btn.dataset.role));
});

loadInvite();

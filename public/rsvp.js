// RSVP page — hunters land here via the magic-link in their invitation
// email. Authentication is the per-hunter token from `?t=…` (no password).

const cfg = window.PEENWERDER_CONFIG || {};

const $ = (sel) => document.querySelector(sel);

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

function showCurrentStatus(status, role) {
  const el = $("#rsvp-current");
  if (!status || status === "pending" || status === "invited") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (status === "accepted") {
    el.className = "rsvp-current rsvp-current-accepted";
    el.textContent = "Aktueller Status: Zugesagt " + (role ? "als " + role + " " : "") + "✓ — Du kannst die Antwort jederzeit ändern.";
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
    showCurrentStatus(data.status, data.role);
  } catch (err) {
    setState("Fehler beim Laden der Einladung: " + (err.message || err), "error");
  }
}

function showRolePicker(show) {
  $("#rsvp-actions").hidden = show;
  $("#rsvp-role-choice").hidden = !show;
}

async function respond(choice, role) {
  const token = getToken();
  if (!token) return;
  const buttons = document.querySelectorAll("#rsvp-actions button, .role-btn, #rsvp-role-back");
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const payload = { action: "rsvp-respond", token, choice };
    if (role) payload.role = role;
    const res = await fetch(cfg.APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const msg = choice === "accept"
      ? "Danke! Deine Zusage als " + (role || "Teilnehmer") + " ist registriert ✓"
      : "Schade — die Absage ist registriert.";
    $("#rsvp-card").hidden = true;
    setState(msg, choice === "accept" ? "accepted" : "declined");
  } catch (err) {
    buttons.forEach((b) => { b.disabled = false; });
    setState("Fehler: " + (err.message || err), "error");
  }
}

$("#rsvp-accept").addEventListener("click", () => showRolePicker(true));
$("#rsvp-decline").addEventListener("click", () => respond("decline"));
$("#rsvp-role-back").addEventListener("click", () => showRolePicker(false));
document.querySelectorAll(".role-btn").forEach((btn) => {
  btn.addEventListener("click", () => respond("accept", btn.dataset.role));
});

loadInvite();

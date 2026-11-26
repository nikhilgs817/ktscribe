/* Pocket Scribe front-end: one page, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  sessions: [], phone: null, health: null, settings: {}, defaults: {},
  cur: null, meta: null, transcript: { segments: [] }, frames: [], summary: {}, runbook: { text: "" },
  invite: null, bundle: null, chat: [], tab: "overview", rbMode: "preview", rbDirty: false, segIndex: [],
  chatBusy: false, dismissed: "", nextOptions: { language: "", vocabulary: "", frame_sensitivity: "", title: "" },
};

// ------------------------------------------------------------------ helpers
async function api(path, opts = {}) {
  const o = { ...opts, headers: { ...(opts.headers || {}) } };
  if (o.body && typeof o.body !== "string" && !(o.body instanceof Blob)) { o.body = JSON.stringify(o.body); o.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, o);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch {}
    throw new Error(msg);
  }
  const ct = r.headers.get("content-type") || "";
  return ct.includes("json") ? r.json() : r.text();
}
function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind; t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), kind === "err" ? 7000 : 3500);
}
function ts(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(s).padStart(2, "0");
}
function parseTs(str) {
  const p = String(str).split(":").map(Number);
  if (p.some(isNaN)) return null;
  return p.reduce((a, v) => a * 60 + v, 0);
}
function dur(sec) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600), m = Math.max(1, Math.round((sec % 3600) / 60));
  return h ? `${h} h ${m} min` : `${m} min`;
}
function when(t) {
  const d = new Date(t * 1000), now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return "Today " + time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday " + time;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + time;
}
function ago(t) {
  const d = Date.now() / 1000 - t;
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + " min ago";
  if (d < 86400) return Math.floor(d / 3600) + " h ago";
  return new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const kb = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB";
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const st = (m, k) => (m?.[k] || {}).state || "none";
const isBusy = (m) => m && (m.status === "running" || m.status === "queued");
const rbBusy = (m) => ["running", "queued"].includes(st(m, "runbook"));
const invBusy = (m) => ["running", "queued"].includes(st(m, "invite"));
const anyBusy = (m) => isBusy(m) || rbBusy(m) || invBusy(m) || ["running", "queued"].includes(st(m, "drive"));

// ------------------------------------------------------------------ theme
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(pref) {
  pref = pref || "system";
  try { localStorage.setItem("ps-theme", pref); } catch {}
  const dark = pref === "dark" || (pref === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
function applyAnim(on) {
  document.documentElement.classList.toggle("no-anim", on === false);
  try { localStorage.setItem("ps-anim", on === false ? "off" : "on"); } catch {}
}
darkQuery.addEventListener("change", () => applyTheme(S.settings.theme));
$("#themeBtn").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next); saveSetting("theme", next);
};

// ------------------------------------------------------------------ markdown
marked.use({
  gfm: true, breaks: false,
  renderer: {
    html(tok) { return esc(tok.text || tok.raw || ""); },
    image(tok) {
      let src = tok.href || "";
      const m = src.match(/^frame:(F\d+)/);
      if (m && S.cur) src = `/api/sessions/${S.cur}/frames/${m[1]}.jpg`;
      return `<figure><img src="${esc(src)}" alt="${esc(tok.text)}" loading="lazy" data-zoom><figcaption>${esc(tok.text)}</figcaption></figure>`;
    },
    link(tok) { return `<a href="${esc(tok.href)}" target="_blank" rel="noopener">${this.parser.parseInline(tok.tokens)}</a>`; },
  },
});
function md(text) {
  const html = marked.parse(text || "");
  return html.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_, t) => `<button class="tchip" data-t="${parseTs(t)}">${t}</button>`);
}
document.addEventListener("click", (e) => {
  const c = e.target.closest(".tchip, [data-seek]");
  if (c) { seek(+(c.dataset.t ?? c.dataset.seek)); return; }
  const z = e.target.closest("[data-zoom]");
  if (z) { $("#lightImg").src = z.src; $("#lightCap").textContent = z.alt || ""; $("#lightbox").hidden = false; }
});
$("#lightbox").onclick = () => ($("#lightbox").hidden = true);

// ------------------------------------------------------------------ step rail
const RAIL = [["audio", "Audio"], ["transcript", "Transcript"], ["shots", "Screenshots"], ["summary", "Summary"], ["kt", "KT document"], ["invite", "Invite"]];
function railStates(m) {
  if (!m.stages) return Object.fromEntries(RAIL.map(([k]) => [k, m._phone === "available" ? (k === "audio" ? "turn" : "pending") : "pending"]));
  const g = m.stages;
  const shots = g.frames === "skipped" ? "skipped" : [g.frames, g.captions].includes("running") ? "running"
    : g.frames === "error" ? "error" : g.frames === "done" && g.captions !== "pending" ? "done" : "pending";
  const out = (state, auto) => ({ running: "running", queued: "running", done: "done", error: "error" }[state]
    || (m.status === "ready" && !auto ? "turn" : "pending"));
  return {
    audio: g.audio, transcript: g.transcript, shots, summary: g.summary === "error" ? "error" : g.summary,
    kt: out(st(m, "runbook"), S.settings.auto_kt_doc), invite: out(st(m, "invite"), S.settings.auto_invite),
  };
}
function rail(m, big = false) {
  const s = railStates(m);
  let h = "";
  RAIL.forEach(([k, label], i) => {
    const state = s[k] || "pending";
    if (i) {
      const prev = s[RAIL[i - 1][0]];
      const line = ["done", "skipped"].includes(prev) && ["done", "skipped"].includes(state) ? "done" : state === "running" ? "run" : "";
      h += `<span class="line ${line}"></span>`;
    }
    h += `<span class="node ${state}" title="${label}: ${state}"><i></i>${label}</span>`;
  });
  return `<div class="rail ${big ? "big" : ""}">${h}</div>`;
}
function badge(m) {
  if (m._phone === "syncing") return ["SYNCING", "warn"];
  if (m._phone === "available") return ["YOUR TURN", "bad turn"];
  if (anyBusy(m)) return [m.status === "queued" ? "QUEUED" : "WORKING", "info work"];
  if (m.status === "error") return ["YOUR TURN", "bad turn"];
  if (m.status === "cancelled") return ["STOPPED", "warn"];
  if ([st(m, "runbook"), st(m, "invite")].includes("error")) return ["CHECK", "warn"];
  if (m.status === "ready") return ["READY", "ok ready"];
  return ["", ""];
}

// ------------------------------------------------------------------ main list
const REEL = `<svg viewBox="0 0 48 48"><circle class="disc" cx="24" cy="24" r="23"/>
  <circle class="groove" cx="24" cy="24" r="19"/><circle class="groove" cx="24" cy="24" r="15"/><circle class="groove" cx="24" cy="24" r="11.5"/>
  <circle class="hub" cx="24" cy="24" r="7.5"/><circle class="spoke" cx="24" cy="24" r="2"/><circle class="spoke" cx="27.5" cy="20.5" r="1.1"/></svg>`;
function phoneRows() {
  const known = new Set(S.sessions.map((s) => s.phone_recording_id).filter(Boolean));
  return (S.phone?.recordings || []).filter((r) => !r.sessionId && !known.has(r.id)).map((r) => ({
    id: "phone:" + r.id, _rec: r, _phone: r.state === "available" ? "available" : "syncing", title: r.title,
    created: Date.parse(r.startedAt) / 1000 || 0, duration: (r.durationMs || 0) / 1000, from_phone: true,
  }));
}
function metaLine(m) {
  const parts = [m.created ? when(m.created) : "", m.duration ? dur(m.duration) : ""];
  parts.push(m.phone_recording_id || m.from_phone ? "From phone" : "From this PC");
  if (m._phone === "syncing") parts.push("Waiting for Google Drive to finish syncing");
  else if (m._phone === "available") {
    const since = Date.parse(S.settings.auto_process_since || "") / 1000 || Infinity;
    parts.push(S.settings.auto_process_phone && m.created >= since ? "Starts in a moment" : "Select Process to start");
  }
  else if (isBusy(m)) parts.push(`${m.message || "Working"} ${Math.round((m.progress || 0) * 100)}%`);
  else if (rbBusy(m)) parts.push("Writing the KT document" + (m.runbook?.chars ? ` · ${m.runbook.chars.toLocaleString()} characters` : ""));
  else if (invBusy(m)) parts.push("Drafting the meeting invite");
  else if (m.status === "error") parts.push(m.error || "Stopped");
  else if (st(m, "drive") === "done") parts.push("Copied to Drive");
  return parts.filter(Boolean).map(esc).join(" · ");
}
function cardHtml(m) {
  const [b, cls] = badge(m);
  const btn = m._phone === "available" ? `<button class="btn primary" data-process="${m._rec.id}">Process</button>`
    : m._phone ? "" : m.status === "error" || m.status === "cancelled" ? `<button class="btn primary" data-resume="${m.id}">Resume</button>`
    : `<button class="btn ${m.status === "ready" && !anyBusy(m) ? "primary" : ""}" data-open="${m.id}">Open</button>`;
  return `<article class="card scard" data-id="${esc(m.id)}">
    <div class="reel ${anyBusy(m) ? "turning" : ""}">${REEL}</div>
    <div class="top"><div><div class="title">${esc(m.title || "Untitled")}</div><div class="meta">${metaLine(m)}</div></div></div>
    <div class="act"><span class="badge ${cls}">${b}</span>${btn}</div>
    ${rail(m)}
  </article>`;
}
let lastListHtml = "";
function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const rows = [...phoneRows(), ...S.sessions].sort((a, b) => b.created - a.created)
    .filter((m) => !q || (m.title || "").toLowerCase().includes(q));
  const working = S.sessions.filter(anyBusy).length;
  const ready = S.sessions.filter((m) => m.status === "ready" && !anyBusy(m)).length;
  const yours = S.sessions.filter((m) => m.status === "error").length + phoneRows().filter((r) => r._phone === "available").length;
  $("#counts").textContent = [working && `${working} working`, yours && `${yours} waiting for you`, ready && `${ready} ready`].filter(Boolean).join("  ·  ");
  let html;
  if (rows.length) html = rows.map(cardHtml).join("");
  else if (q) html = `<div class="empty-list"><b>No sessions match “${esc(q)}”</b></div>`;
  else html = `<div class="card empty-list"><b>No sessions yet</b>Record a meeting on your phone, or drop a recording above.
    <div class="how3"><div><b>1 · Record</b>Pocket Scribe on the phone records the call with its camera and mic.</div>
    <div><b>2 · Sync</b>The phone uploads it to Google Drive; it appears here by itself.</div>
    <div><b>3 · Use it</b>Transcript, screenshots, KT document, invite and a bundle for Claude.</div></div></div>`;
  if (html !== lastListHtml) {
    // keep animations calm: only cards whose content changed are replaced
    const box = $("#list");
    const tmp = document.createElement("div"); tmp.innerHTML = html;
    const old = new Map($$(".scard", box).map((el) => [el.dataset.id, el]));
    const next = [...tmp.children];
    if (next.every((n) => n.classList.contains("scard")) && old.size) {
      box.replaceChildren(...next.map((n) => {
        const o = old.get(n.dataset.id);
        if (o && o.innerHTML === n.innerHTML) return o;
        if (o) n.style.animation = "none";
        return n;
      }));
    } else box.innerHTML = html;
    lastListHtml = html;
  }
  renderActionBar(ready, yours, working);
}
function renderActionBar(ready, yours, working) {
  const btn = $("#actionBtn");
  const avail = phoneRows().filter((r) => r._phone === "available");
  const latest = S.sessions.find((m) => m.status === "ready");
  btn.hidden = false;
  if (avail.length) {
    $("#actionText").textContent = `${avail.length} phone recording${avail.length > 1 ? "s are" : " is"} ready to process.`;
    btn.textContent = avail.length > 1 ? `Process all (${avail.length})` : "Process";
    btn.onclick = async () => { for (const r of avail) await processPhone(r._rec.id); };
  } else if (yours) {
    const m = S.sessions.find((x) => x.status === "error");
    $("#actionText").textContent = `“${m.title}” stopped: ${m.error || "see the session"}.`;
    btn.textContent = "Open it"; btn.onclick = () => openSession(m.id);
  } else if (working) {
    const m = S.sessions.find(anyBusy);
    $("#actionText").textContent = `Working on “${m.title}”. You can close this window; it carries on in the background.`;
    btn.textContent = "Watch it"; btn.onclick = () => openSession(m.id, "transcript");
  } else if (latest) {
    $("#actionText").textContent = `${ready} session${ready > 1 ? "s are" : " is"} ready. Open one for the KT document, the invite or the Claude bundle.`;
    btn.textContent = "Open latest"; btn.onclick = () => openSession(latest.id);
  } else {
    $("#actionText").textContent = "Add a recording, or record on your phone.";
    btn.hidden = true;
  }
}
$("#search").oninput = () => { lastListHtml = ""; renderList(); };
$("#list").onclick = async (e) => {
  const p = e.target.closest("[data-process]"); if (p) { e.stopPropagation(); return processPhone(p.dataset.process); }
  const r = e.target.closest("[data-resume]"); if (r) { e.stopPropagation(); S.cur = r.dataset.resume; await resume(); S.cur = null; return; }
  const c = e.target.closest(".scard"); if (!c || c.dataset.id.startsWith("phone:")) return;
  openSession(c.dataset.id);
};
async function loadSessions() {
  try { S.sessions = await api("/api/sessions"); } catch { return; }
  renderList();
}

// ------------------------------------------------------------------ phone & Drive strip
async function loadPhone() {
  try { S.phone = await api("/api/phone-recordings"); } catch { S.phone = null; }
  renderPhone(); renderList();
}
function renderPhone() {
  const p = S.phone, auto = !!S.settings.auto_process_phone;
  $("#autoToggle").checked = auto;
  const chip = $("#phoneChip");
  if (!p || !p.folderAvailable) {
    chip.className = "chip warn"; chip.lastElementChild.textContent = "NO DRIVE";
    $("#phoneTitle").textContent = "Google Drive folder not found";
    $("#phoneSub").textContent = p?.folder ? `${p.folder} isn't reachable. Open Google Drive for desktop.` : "Install Google Drive for desktop and sign in, or set the folder in Settings › Phone & Google Drive.";
    return;
  }
  const waiting = (p.recordings || []).filter((r) => r.state === "syncing").length;
  chip.className = "chip " + (auto ? "ok" : "info"); chip.lastElementChild.textContent = auto ? "WATCHING" : "MANUAL";
  $("#phoneTitle").textContent = auto ? "New phone recordings start by themselves" : "Phone recordings wait for you";
  $("#phoneSub").textContent = p.folder + (waiting ? ` · ${waiting} still syncing` : ` · ${p.recordings.length} recording${p.recordings.length === 1 ? "" : "s"}`);
}
$("#autoToggle").onchange = async (e) => { await saveSetting("auto_process_phone", e.target.checked); renderPhone(); renderList(); };
$("#phoneCheckBtn").onclick = async () => { $("#phoneCheckBtn").disabled = true; await loadPhone(); $("#phoneCheckBtn").disabled = false; toast("Checked Google Drive"); };
async function processPhone(id) {
  try {
    const m = await api(`/api/phone-recordings/${id}/process`, { method: "POST", body: {} });
    toast(`Started “${m.title}”`, "ok");
    await Promise.all([loadSessions(), loadPhone()]); poll();
  } catch (e) { toast(e.message, "err"); }
}

// ------------------------------------------------------------------ health & banner
async function checkHealth() {
  try {
    const h = await api("/api/health");
    S.health = h; S.settings = h.settings;
    applyTheme(S.settings.theme); applyAnim(S.settings.animations);
  } catch { S.health = null; }
  renderHealth();
}
function renderHealth() {
  const h = S.health, pill = $("#sysPill");
  let text, cls, problem = null;
  if (!h) { text = "OFFLINE"; cls = "bad"; problem = ["OFFLINE", "Pocket Scribe's background service isn't answering. Open it again from the desktop shortcut."]; }
  else if (!h.ffmpeg) { text = "NEEDS FFMPEG"; cls = "bad"; problem = ["FFMPEG", "ffmpeg is missing, so recordings can't be read. Run Setup Pocket Scribe Desktop again."]; }
  else if (!h.ollama) { text = "AI OFFLINE"; cls = "warn"; problem = ["AI OFFLINE", `Can't reach ${h.engine}. Transcripts and screenshots still work; the summary, KT document and invite wait for the AI. ${h.ollama_error || ""}`, "Settings"]; }
  else if (!h.settings.writer_model || !h.settings.assistant_model) { text = "PICK MODELS"; cls = "warn"; problem = ["MODELS", "Pick the models Pocket Scribe should use.", "Settings"]; }
  else { text = "MODELS READY"; cls = "ok"; }
  pill.className = "pill " + cls; pill.lastElementChild.textContent = text;
  pill.title = h ? h.engine : "";
  const key = problem ? problem[1] : "";
  $("#banner").hidden = !problem || S.dismissed === key;
  if (problem) {
    $("#bannerChip").className = "chip " + (cls === "bad" ? "bad" : "warn");
    $("#bannerChip").lastElementChild.textContent = problem[0];
    $("#bannerText").textContent = problem[1];
    $("#bannerAction").hidden = !problem[2];
    $("#bannerAction").textContent = problem[2] || "";
    $("#bannerDismiss").onclick = () => { S.dismissed = key; $("#banner").hidden = true; };
  }
}
$("#bannerAction").onclick = () => openSettings();

// ------------------------------------------------------------------ sheets
function openSheet(el) {
  el.hidden = false; el.classList.remove("closing");
  document.body.classList.add("sheet-open");
}
function closeSheet(el) {
  if (el.hidden) return;
  el.classList.add("closing");
  const done = () => { el.hidden = true; el.classList.remove("closing"); if (!$$(".sheet:not([hidden])").length) document.body.classList.remove("sheet-open"); };
  if (document.documentElement.classList.contains("no-anim")) done(); else setTimeout(done, 220);
}
$$("[data-close]").forEach((b) => (b.onclick = () => {
  const d = b.closest("dialog"); if (d) return d.close();
  const s = b.closest(".sheet"); if (s === $("#settingsSheet")) closeSettings(); else closeSheet(s);
}));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
  if (!$("#lightbox").hidden) { $("#lightbox").hidden = true; return; }
  const open = $$(".sheet:not([hidden])").pop();
  if (!open) return;
  if (open.id === "sessionSheet") closeSession(); else if (open.id === "settingsSheet") closeSettings(); else closeSheet(open);
});

// ------------------------------------------------------------------ video
const video = $("#video");
function seek(t) {
  if (t == null || isNaN(t) || !S.cur) return;
  video.currentTime = Math.max(0, t - 0.3);
  video.play().catch(() => {});
}
$("#rateSel").onchange = (e) => (video.playbackRate = +e.target.value);
video.addEventListener("error", () => {
  if (!S.cur || !video.getAttribute("src")) return;
  $("#playerMsg").hidden = false;
  $("#playerMsg").textContent = "This browser can't play the file. The transcript, KT document and Ask still work.";
});
video.addEventListener("loadeddata", () => ($("#playerMsg").hidden = true));
video.addEventListener("timeupdate", () => highlightNow(video.currentTime));
let lastNow = -1;
function highlightNow(t) {
  const idx = S.segIndex;
  if (idx.length) {
    let lo = 0, hi = idx.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (idx[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    const id = ans >= 0 ? idx[ans].id : -1;
    if (id !== lastNow) {
      $$(".seg-s.now").forEach((e) => e.classList.remove("now"));
      lastNow = id;
      const el = document.querySelector(`.seg-s[data-id="${id}"]`);
      if (el) {
        el.classList.add("now");
        if ($("#followToggle").checked && S.tab === "transcript" && !video.paused) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }
  $$(".chapter").forEach((c) => c.classList.remove("now"));
  const chs = $$(".chapter").filter((c) => +c.dataset.seek <= t + 1);
  if (chs.length) chs[chs.length - 1].classList.add("now");
}

// ------------------------------------------------------------------ session sheet
async function openSession(id, tab) {
  const m = await api(`/api/sessions/${id}`).catch(() => null);
  if (!m) { toast("That session isn't there any more", "err"); return; }
  S.cur = id; S.meta = m; S.transcript = { segments: [] }; S.segIndex = []; S.frames = []; S.summary = {}; S.chat = [];
  S.runbook = { text: "" }; S.invite = null; S.bundle = null; S.rbDirty = false; lastNow = -1;
  history.replaceState(null, "", "#" + id);
  video.src = m.video_path ? `/api/sessions/${id}/video` : "";
  $("#playerMsg").hidden = true;
  $("#genPanel").hidden = true;
  openSheet($("#sessionSheet"));
  $(".content-col").scrollTop = 0;
  await Promise.all([loadTranscript(), loadFrames(), loadSummary(), loadRunbook(), loadInvite(), loadChat()]);
  renderMeta();
  switchTab(tab || (isBusy(m) ? "transcript" : "overview"));
  poll();
}
async function closeSession() {
  if (S.rbDirty) await saveRunbook();
  video.pause();
  closeSheet($("#sessionSheet"));
  S.cur = null; S.meta = null;
  history.replaceState(null, "", location.pathname);
  setTimeout(() => { if (!S.cur) video.removeAttribute("src"); }, 300);
  loadSessions();
}
$("#backBtn").onclick = closeSession;

function renderMeta() {
  const m = S.meta; if (!m) return;
  if (document.activeElement !== $("#svTitle")) $("#svTitle").textContent = m.title || "Untitled";
  const segs = S.transcript.segments || [];
  const words = segs.reduce((a, s) => a + s.text.split(/\s+/).length, 0);
  $("#svMeta").textContent = [
    new Date(m.created * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    m.duration ? dur(m.duration) : "", words ? words.toLocaleString() + " words" : "",
    m.phone_recording_id ? "From phone" : "", S.transcript.language ? S.transcript.language.toUpperCase() : "",
  ].filter(Boolean).join(" · ");
  const [b, cls] = badge(m);
  $("#svBadge").className = "badge " + cls; $("#svBadge").textContent = b; $("#svBadge").hidden = !b;
  $("#svRail").outerHTML = rail(m, true).replace('class="rail big"', 'class="rail big" id="svRail"');
  const busy = isBusy(m);
  let msg;
  if (busy) msg = `${m.message || "Working"} · ${Math.round((m.progress || 0) * 100)}%`;
  else if (m.status === "error") msg = `<span class="warn-text">${esc(m.error || "Stopped")}</span>`;
  else if (m.status === "cancelled") msg = "Stopped. Resume carries on where it left off.";
  else if (rbBusy(m)) msg = `Writing the KT document${m.runbook?.chars ? ` · ${m.runbook.chars.toLocaleString()} characters` : ""}`;
  else if (invBusy(m)) msg = "Drafting the meeting invite";
  else if (st(m, "drive") === "running" || st(m, "drive") === "queued") msg = "Copying the outputs to Google Drive";
  else if (st(m, "drive") === "done") msg = `Ready. Outputs copied to Google Drive › Pocket Scribe › Outputs.`;
  else msg = "Ready.";
  $("#progressMsg").innerHTML = m.status === "error" && !busy ? msg : esc(msg);
  $("#cancelBtn").hidden = !busy;
  $("#resumeBtn").hidden = !(m.status === "error" || m.status === "cancelled");
  const w = m.warnings || [];
  $("#warnBanner").hidden = !w.length;
  $("#warnBanner").innerHTML = w.length ? `<span class="chip warn"><i></i><span>CHECK</span></span><div class="strip-text">${w.map(esc).join("<br>")}</div><button class="btn" id="retryLLM">Try again</button>` : "";
  const rl = $("#retryLLM"); if (rl) rl.onclick = () => resume(w.some((x) => x.startsWith("Screenshot")) ? "captions" : "summary");
  $("#frameCount").textContent = S.frames.filter((f) => !f.hidden && f.kind !== "webcam").length || "";
  if (S.tab === "overview") renderOverview();
}
$("#svTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
$("#svTitle").addEventListener("blur", async (e) => {
  const t = e.target.textContent.trim();
  if (S.meta && t && t !== S.meta.title) { S.meta = await api(`/api/sessions/${S.cur}`, { method: "PATCH", body: { title: t } }); loadSessions(); toast("Renamed", "ok"); }
});
$("#cancelBtn").onclick = async () => { await api(`/api/sessions/${S.cur}/cancel`, { method: "POST" }); toast("Stopping…"); };
$("#resumeBtn").onclick = () => resume();
async function resume(redo, options) {
  try {
    const body = {}; if (redo) body.redo = redo; if (options) body.options = options;
    const m = await api(`/api/sessions/${S.cur}/resume`, { method: "POST", body });
    if (S.meta && S.meta.id === m.id) { S.meta = m; renderMeta(); }
    loadSessions(); poll();
  } catch (e) { toast(e.message, "err"); }
}
$("#deleteBtn").onclick = async () => {
  const m = S.meta;
  if (!confirm(`Delete “${m.title}”?\n\nThis removes its transcript, screenshots, KT document and invite from this PC.` +
    (m.video_copied ? " The copy of the recording is deleted too." : " Your original recording file is not touched.") +
    (m.phone_recording_id ? " The phone's copy in Google Drive stays." : ""))) return;
  await api(`/api/sessions/${S.cur}`, { method: "DELETE" });
  toast("Session deleted"); closeSession();
};

function renderExportMenu() {
  const b = `/api/sessions/${S.cur}/export`;
  const hasT = (S.transcript.segments || []).length, hasR = (S.runbook.text || "").trim(), hasS = S.summary?.summary, hasI = !!S.invite;
  const it = (href, label, sub) => `<a class="mi" href="${href}" download>${label}<span>${sub}</span></a>`;
  const none = (t) => `<div class="mi muted">${t}</div>`;
  $("#exportMenu").innerHTML = `
    <h6>KT document</h6>${hasR ? it(`${b}/runbook.docx`, "Word", ".docx") + it(`${b}/runbook.pdf`, "PDF", ".pdf") + it(`${b}/runbook.md`, "Markdown", ".md") : none("Write it first")}
    <h6>Meeting invite</h6>${hasI ? it(`${b}/invite.ics`, "Calendar invite", ".ics") + it(`${b}/invite.txt`, "Text", ".txt") : none("Draft it first")}
    <h6>For Claude</h6>${hasT ? it(`${b}/bundle.zip`, "Claude bundle", ".zip") : none("After the transcript")}
    <h6>Transcript</h6>${hasT ? it(`${b}/transcript.docx`, "Word", ".docx") + it(`${b}/transcript.txt`, "Text", ".txt") + it(`${b}/transcript.srt`, "Subtitles", ".srt") : none("Not ready yet")}
    ${hasS ? `<h6>Summary</h6>${it(`${b}/summary.docx`, "Word", ".docx")}${it(`${b}/summary.pdf`, "PDF", ".pdf")}` : ""}`;
}
$("#exportBtn").onclick = (e) => { e.stopPropagation(); renderExportMenu(); $("#exportMenu").hidden = !$("#exportMenu").hidden; };
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) $("#exportMenu").hidden = true; });

// ------------------------------------------------------------------ tabs
$("#tabs").onclick = (e) => { const b = e.target.closest("button[data-tab]"); if (b) switchTab(b.dataset.tab); };
function switchTab(tab) {
  if (S.tab === "runbook" && tab !== "runbook" && S.rbDirty) saveRunbook();
  S.tab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$("#sessionSheet .pane").forEach((p) => (p.hidden = p.dataset.pane !== tab));
  ({ overview: renderOverview, transcript: renderTranscript, runbook: renderRunbook, frames: renderFrames,
    invite: renderInvite, bundle: loadBundle, ask: renderChat })[tab]?.();
}

// ------------------------------------------------------------------ overview
async function loadSummary() { S.summary = await api(`/api/sessions/${S.cur}/summary`).catch(() => ({})); renderChapters(); }
function renderChapters() {
  const chs = S.summary?.chapters || [];
  $("#chapterList").innerHTML = chs.length ? chs.map((c) => `<button class="chapter" data-seek="${parseTs(c.start) ?? 0}"><span class="t">${esc(c.start)}</span><span><b>${esc(c.title)}</b>${c.summary ? `<em>${esc(c.summary)}</em>` : ""}</span></button>`).join("")
    : `<div class="muted small">${isBusy(S.meta) ? "Chapters appear after the summary." : "No chapters."}</div>`;
  highlightNow(video.currentTime || 0);
}
const inl = (x) => md(esc(x)).replace(/^<p>|<\/p>\s*$/g, "");
function outState(key) {
  const s = st(S.meta, key);
  return { running: "Working…", queued: "Queued", error: "Failed", done: "Ready" }[s] || "Not yet";
}
function renderOverview() {
  const m = S.meta, s = S.summary || {};
  const segs = S.transcript.segments || [];
  const shots = S.frames.filter((f) => !f.hidden && f.kind !== "webcam").length;
  const words = segs.reduce((a, x) => a + x.text.split(/\s+/).length, 0);
  const list = (arr) => `<ul>${arr.map((x) => `<li>${inl(x)}</li>`).join("")}</ul>`;
  const hasKt = (S.runbook.text || "").trim();
  let h = `<div class="ov">
    <div class="stat-row">
      <div class="stat"><b>${m.duration ? dur(m.duration) : "–"}</b><span>Recording</span></div>
      <div class="stat"><b>${words ? words.toLocaleString() : "–"}</b><span>Words</span></div>
      <div class="stat"><b>${shots || "–"}</b><span>Screenshots</span></div>
      <div class="stat"><b>${hasKt ? "Ready" : outState("runbook")}</b><span>KT document</span></div>
    </div>
    <div class="quick">
      <button class="btn sm ${hasKt ? "" : "primary"}" data-go="runbook">${hasKt ? "Open KT document" : "Write KT document"}</button>
      <button class="btn sm" data-go="invite">${S.invite ? "Meeting invite" : "Draft meeting invite"}</button>
      <button class="btn sm" data-go="bundle">Bundle for Claude</button>
      <button class="btn sm" data-go="ask">Ask a question</button>
    </div>`;
  if (s.summary) {
    h += `<h3>Summary</h3><p class="lead">${esc(s.summary)}</p>`;
    if (s.key_points?.length) h += `<h3>Key points</h3>${list(s.key_points)}`;
    if (s.systems?.length) h += `<h3>Systems and tools</h3><div class="chips">${s.systems.map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</div>`;
    h += `<div class="ov-grid">
      <div class="ov-box"><h3>Action items</h3>${s.action_items?.length ? list(s.action_items) : '<p class="muted small">None noted</p>'}</div>
      <div class="ov-box"><h3>Open questions</h3>${s.open_questions?.length ? list(s.open_questions) : '<p class="muted small">None noted</p>'}</div></div>`;
  } else if (isBusy(m)) {
    h += `<div class="empty"><b><span class="spin"></span> ${esc(m.message || "Working")}</b>The transcript fills in live under Transcript. The summary and chapters follow.</div>`;
  } else {
    h += `<div class="empty"><b>No summary yet</b>${m.stages?.summary === "error" ? "The AI couldn't write it. Check Settings › AI models, then " : ""}<button class="link-btn" id="redoSum">write the summary now</button>.</div>`;
  }
  $("#overviewPane").innerHTML = h + "</div>";
  $$("#overviewPane [data-go]").forEach((b) => (b.onclick = () => { switchTab(b.dataset.go); if (b.dataset.go === "runbook" && !hasKt) openGenPanel(); }));
  const rs = $("#redoSum"); if (rs) rs.onclick = () => resume("summary");
}

// ------------------------------------------------------------------ transcript
async function loadTranscript() {
  S.transcript = await api(`/api/sessions/${S.cur}/transcript`).catch(() => ({ segments: [] }));
  S.segIndex = (S.transcript.segments || []).map((s) => ({ id: s.id, start: s.start }));
  if (S.tab === "transcript") renderTranscript();
}
function blocks(segs, breaks = [], maxSec = 30, gap = 2.5) {
  const out = []; let cur = null;
  for (const s of segs) {
    const crosses = cur && breaks.some((b) => b > cur.start + 1 && b <= s.start + 1);
    if (cur && (crosses || s.start - cur.end > gap || s.end - cur.start > maxSec)) { out.push(cur); cur = null; }
    if (!cur) cur = { start: s.start, end: s.end, segs: [s] }; else { cur.end = s.end; cur.segs.push(s); }
  }
  if (cur) out.push(cur);
  return out;
}
let searchPos = -1;
function renderTranscript() {
  const segs = S.transcript.segments || [];
  const q = $("#tSearch").value.trim();
  const box = $("#transcript"), pane = box.closest(".pane"), keep = pane.scrollTop;
  if (!segs.length) {
    box.innerHTML = `<div class="empty"><b>${isBusy(S.meta) ? '<span class="spin"></span> Transcribing' : "No transcript"}</b>${isBusy(S.meta) ? "Text starts appearing here in a moment." : ""}</div>`;
    $("#tStats").textContent = ""; return;
  }
  const chs = (S.summary?.chapters || []).map((c) => ({ t: parseTs(c.start) ?? 0, title: c.title }));
  let ci = 0, hits = 0;
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : null;
  box.innerHTML = blocks(segs, chs.map((c) => c.t)).map((b) => {
    let pre = "";
    while (ci < chs.length && chs[ci].t <= b.start + 1) { pre += `<div class="tchapter">${esc(chs[ci].title)}</div>`; ci++; }
    const inner = b.segs.map((s) => {
      let t = esc(s.text);
      if (re) t = t.replace(re, (mm) => { hits++; return `<mark>${mm}</mark>`; });
      return `<span class="seg-s" data-id="${s.id}" data-start="${s.start}">${t}</span>`;
    }).join(" ");
    return `${pre}<div class="tblock"><button class="ts" data-seek="${b.start}">${ts(b.start)}</button><p>${inner}</p></div>`;
  }).join("") + (S.transcript.partial && isBusy(S.meta) ? `<div class="live-tail"><span class="spin"></span> Transcribing · ${Math.round((S.meta.progress || 0) * 100)}%</div>` : "");
  $("#tSearchCount").textContent = q ? `${hits} match${hits === 1 ? "" : "es"}` : "";
  const words = segs.reduce((a, s) => a + s.text.split(/\s+/).length, 0);
  $("#tStats").textContent = `${words.toLocaleString()} words · double-click to correct`;
  pane.scrollTop = keep; lastNow = -1; highlightNow(video.currentTime); searchPos = -1;
}
$("#tSearch").addEventListener("input", debounce(renderTranscript, 200));
$("#tSearch").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const ms = $$("#transcript mark"); if (!ms.length) return;
  ms.forEach((m) => m.classList.remove("cur"));
  searchPos = (searchPos + (e.shiftKey ? -1 : 1) + ms.length) % ms.length;
  ms[searchPos].classList.add("cur"); ms[searchPos].scrollIntoView({ block: "center" });
});
$("#transcript").addEventListener("click", (e) => {
  const s = e.target.closest(".seg-s");
  if (s && s.contentEditable !== "true" && !getSelection().toString() && e.detail === 1) { clearTimeout(s._t); s._t = setTimeout(() => seek(+s.dataset.start), 220); }
});
$("#transcript").addEventListener("dblclick", (e) => {
  const s = e.target.closest(".seg-s"); if (!s) return;
  clearTimeout(s._t);
  s.contentEditable = "true"; s.textContent = s.textContent; s.focus();
  const done = async (save) => {
    s.contentEditable = "false"; s.removeEventListener("blur", onBlur);
    const seg = S.transcript.segments.find((x) => x.id === +s.dataset.id);
    const txt = s.textContent.trim();
    if (save && seg && txt && txt !== seg.text) {
      seg.text = txt;
      await api(`/api/sessions/${S.cur}/transcript/segment`, { method: "PUT", body: { id: seg.id, text: txt } });
      toast("Correction saved", "ok");
    } else if (seg) s.textContent = seg.text;
  };
  const onBlur = () => done(true);
  s.addEventListener("blur", onBlur);
  s.onkeydown = (k) => { if (k.key === "Enter") { k.preventDefault(); s.blur(); } if (k.key === "Escape") { s.removeEventListener("blur", onBlur); done(false); } };
});
$("#replaceToggle").onclick = () => { $("#replaceRow").hidden = !$("#replaceRow").hidden; if (!$("#replaceRow").hidden) $("#rFind").focus(); };
$("#rGo").onclick = async () => {
  const find = $("#rFind").value.trim(); if (!find) return;
  const r = await api(`/api/sessions/${S.cur}/transcript/replace`, { method: "POST", body: { find, replace: $("#rWith").value, whole: $("#rWhole").checked } });
  toast(`Replaced ${r.count} time${r.count === 1 ? "" : "s"}`, "ok");
  await loadTranscript();
};

// ------------------------------------------------------------------ KT document
async function loadRunbook() {
  const r = await api(`/api/sessions/${S.cur}/runbook`).catch(() => ({ text: "" }));
  if (S.rbDirty && !rbBusy(S.meta)) return;
  S.runbook = r;
  if (S.tab === "runbook") renderRunbook();
}
function renderRunbook() {
  const m = S.meta, r = S.runbook, busy = rbBusy(m);
  const ed = $("#rbEditor");
  if (document.activeElement !== ed || busy) ed.value = r.text || "";
  ed.readOnly = busy;
  $("#rbPreview").innerHTML = (r.text || "").trim() ? md(r.text) : busy
    ? `<div class="empty"><b><span class="spin"></span> ${st(m, "runbook") === "queued" ? "Waiting for the current job" : "The writer is reading the session"}</b>Text appears here as it's written. Big local models can take a minute to start.</div>`
    : `<div class="empty"><b>No KT document yet</b>Pocket Scribe writes it from the transcript and screenshots with ${esc(S.settings.writer_model || "the writer model")}. You can edit it afterwards.<br><br><button class="btn primary" id="genEmpty">Write KT document</button></div>`;
  const ge = $("#genEmpty"); if (ge) ge.onclick = openGenPanel;
  const rs = m.runbook || {}, box = $("#rbStatus");
  if (busy) {
    box.hidden = false; box.className = "rb-status";
    box.innerHTML = `<span class="spin"></span> ${esc(rs.phase || "Working")}${rs.chars ? ` · ${rs.chars.toLocaleString()} characters` : ""}<span class="spacer"></span><button class="btn sm" id="rbCancel">Stop</button>`;
    $("#rbCancel").onclick = () => api(`/api/sessions/${S.cur}/runbook/cancel`, { method: "POST" });
  } else if (rs.state === "error") {
    box.hidden = false; box.className = "rb-status err"; box.textContent = rs.error || "The writer stopped.";
  } else box.hidden = true;
  $("#genBtn").disabled = busy;
  $("#genBtn").textContent = (r.text || "").trim() ? "Write again" : "Write KT document";
  $("#restoreBtn").hidden = !r.has_previous || busy;
  $("#rbSaved").textContent = busy ? "" : S.rbDirty ? "Saving…" : rs.updated ? "Saved " + ago(rs.updated) : "";
  if (busy && S.rbMode !== "edit") { const p = $("#rbPreview"); p.scrollTop = p.scrollHeight; }
}
function setRbMode(mode) {
  S.rbMode = mode;
  $("#runbookWrap").className = "runbook mode-" + mode;
  $$("#rbMode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}
$("#rbMode").onclick = (e) => { const b = e.target.closest("button"); if (b) setRbMode(b.dataset.mode); };
const saveRunbookSoon = debounce(() => saveRunbook(), 900);
async function saveRunbook() {
  if (!S.rbDirty || !S.cur) return;
  const text = $("#rbEditor").value;
  try {
    await api(`/api/sessions/${S.cur}/runbook`, { method: "PUT", body: { text } });
    S.rbDirty = false; S.runbook.text = text;
    if (S.meta) S.meta.runbook = { ...(S.meta.runbook || {}), updated: Date.now() / 1000, state: "done" };
    $("#rbSaved").textContent = "Saved";
  } catch (e) { toast("Couldn't save: " + e.message, "err"); }
}
$("#rbEditor").addEventListener("input", () => {
  S.rbDirty = true; $("#rbSaved").textContent = "Saving…";
  $("#rbPreview").innerHTML = md($("#rbEditor").value);
  saveRunbookSoon();
});
function openGenPanel() {
  $("#genPanel").hidden = false;
  $("#genModel").textContent = `Writer: ${S.settings.writer_model || "not set"} · ${S.frames.filter((f) => !f.hidden && f.kind !== "webcam").length} screenshots` +
    ((S.runbook.text || "").trim() ? " · The current version is kept as the previous version." : "");
  $("#genInstr").focus();
}
$("#genBtn").onclick = () => ($("#genPanel").hidden ? openGenPanel() : ($("#genPanel").hidden = true));
$("#genCancelPanel").onclick = () => ($("#genPanel").hidden = true);
$("#genGo").onclick = async () => {
  try {
    if (S.rbDirty) await saveRunbook();
    await api(`/api/sessions/${S.cur}/runbook/generate`, { method: "POST", body: { instructions: $("#genInstr").value } });
    $("#genPanel").hidden = true;
    S.meta.runbook = { state: "queued", phase: "Queued" };
    setRbMode("preview"); renderRunbook(); renderMeta(); poll();
  } catch (e) { toast(e.message, "err"); }
};
$("#restoreBtn").onclick = async () => {
  const r = await api(`/api/sessions/${S.cur}/runbook/restore`, { method: "POST" });
  S.runbook.text = r.text; renderRunbook(); toast("Swapped to the previous version");
};
$("#insertShotBtn").onclick = () => {
  const fr = S.frames.filter((f) => !f.hidden);
  $("#pickGrid").innerHTML = fr.length ? fr.map((f) => frameCard(f, true)).join("") : `<div class="empty"><b>No screenshots</b>Use Capture frame under the video.</div>`;
  $("#pickDialog").showModal();
};
$("#pickGrid").onclick = (e) => {
  const c = e.target.closest(".fcard"); if (!c) return;
  insertShot(S.frames.find((x) => x.id === c.dataset.id)); $("#pickDialog").close();
};
function insertShot(f) {
  switchTab("runbook");
  if (S.rbMode === "preview") setRbMode("split");
  const ed = $("#rbEditor");
  const cap = (f.caption || `Screenshot at ${ts(f.t)}`).replace(/[\[\]]/g, "");
  const snippet = `\n\n![${cap}](frame:${f.id})\n\n`;
  const pos = ed.selectionStart ?? ed.value.length;
  ed.value = ed.value.slice(0, pos) + snippet + ed.value.slice(ed.selectionEnd ?? pos);
  ed.focus(); ed.selectionStart = ed.selectionEnd = pos + snippet.length;
  ed.dispatchEvent(new Event("input"));
  toast("Screenshot inserted", "ok");
}

// ------------------------------------------------------------------ screenshots
async function loadFrames() {
  S.frames = await api(`/api/sessions/${S.cur}/frames`).catch(() => []);
  $("#frameCount").textContent = S.frames.filter((f) => !f.hidden && f.kind !== "webcam").length || "";
  if (S.tab === "frames") renderFrames();
}
const ICON = {
  insert: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  describe: '<svg viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
  hide: '<svg viewBox="0 0 24 24"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/><path d="M4 4l16 16"/></svg>',
  show: '<svg viewBox="0 0 24 24"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/></svg>',
};
function frameCard(f, picker = false) {
  const dim = f.hidden || f.kind === "webcam";
  return `<div class="fcard ${dim && !picker ? "dim" : ""}" data-id="${f.id}">
    <div class="fimg" ${picker ? "" : "data-zoomframe"}><img src="/api/sessions/${S.cur}/frames/${f.id}.jpg" loading="lazy" alt="${esc(f.caption)}">
      <span class="t"><button class="tchip" data-t="${f.t}">${ts(f.t)}</button></span>
      ${f.kind === "webcam" ? '<span class="badge warn">WEBCAM</span>' : f.manual ? '<span class="badge info">CAPTURED</span>' : ""}</div>
    <div class="fbody">
      ${picker ? `<div class="fcap">${esc(f.caption)}</div>` : `<div class="fcap" contenteditable="true" spellcheck="false" data-ph="Add a description">${esc(f.caption)}</div>
      <div class="factions">
        <button class="icon-btn" data-act="insert" title="Insert into the KT document">${ICON.insert}</button>
        <button class="icon-btn" data-act="describe" title="Describe with the vision model">${ICON.describe}</button>
        <button class="icon-btn" data-act="hide" title="${f.hidden ? "Show again" : "Hide: leave out of the KT document and the bundle"}">${f.hidden ? ICON.show : ICON.hide}</button>
        <span class="spacer"></span>
        <button class="icon-btn danger" data-act="delete" title="Delete">${ICON.del}</button>
      </div>`}
    </div></div>`;
}
function renderFrames() {
  const all = S.frames, show = $("#showHidden").checked;
  const sens = S.meta?.options?.frame_sensitivity || S.settings.frame_sensitivity || "medium";
  $$("#sensSeg button").forEach((b) => b.classList.toggle("active", b.dataset.v === sens));
  const fr = all.filter((f) => show || (!f.hidden && f.kind !== "webcam"));
  const hiddenN = all.length - all.filter((f) => !f.hidden && f.kind !== "webcam").length;
  $("#frameInfo").textContent = `${all.length - hiddenN} screenshots` + (hiddenN ? ` · ${hiddenN} hidden or webcam` : "");
  $("#frameGrid").innerHTML = fr.length ? fr.map((f) => frameCard(f)).join("") :
    `<div class="empty" style="grid-column:1/-1"><b>${S.meta.stages?.frames === "running" ? '<span class="spin"></span> Finding screen changes' : "No screenshots"}</b>
      ${S.meta.has_video === false ? "This recording is audio only." : "Play the video and use Capture frame to add your own."}</div>`;
}
$("#showHidden").onchange = renderFrames;
$("#sensSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; $$("#sensSeg button").forEach((x) => x.classList.toggle("active", x === b)); };
$("#frameGrid").addEventListener("click", async (e) => {
  const card = e.target.closest(".fcard"); if (!card) return;
  const f = S.frames.find((x) => x.id === card.dataset.id);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act && e.target.closest("[data-zoomframe]") && !e.target.closest(".tchip")) {
    $("#lightImg").src = `/api/sessions/${S.cur}/frames/${f.id}.jpg`; $("#lightCap").textContent = `${ts(f.t)} · ${f.caption || ""}`; $("#lightbox").hidden = false; return;
  }
  if (act === "insert") insertShot(f);
  if (act === "hide") {
    f.hidden = !f.hidden;
    await api(`/api/sessions/${S.cur}/frames/${f.id}`, { method: "PATCH", body: { hidden: f.hidden, kind: f.kind === "webcam" && !f.hidden ? "screen" : f.kind } });
    if (!f.hidden && f.kind === "webcam") f.kind = "screen";
    renderFrames(); $("#frameCount").textContent = S.frames.filter((x) => !x.hidden && x.kind !== "webcam").length || "";
  }
  if (act === "delete") { if (!confirm("Delete this screenshot?")) return; await api(`/api/sessions/${S.cur}/frames/${f.id}`, { method: "DELETE" }); S.frames = S.frames.filter((x) => x !== f); renderFrames(); }
  if (act === "describe") {
    const b = e.target.closest("[data-act]"); b.innerHTML = '<span class="spin"></span>';
    try { Object.assign(f, await api(`/api/sessions/${S.cur}/frames/${f.id}/describe`, { method: "POST" })); renderFrames(); }
    catch (err) { toast(err.message, "err"); b.innerHTML = ICON.describe; }
  }
});
$("#frameGrid").addEventListener("focusout", async (e) => {
  const c = e.target.closest(".fcap"); if (!c) return;
  const f = S.frames.find((x) => x.id === c.closest(".fcard").dataset.id);
  const t = c.textContent.trim();
  if (f && t !== (f.caption || "")) { f.caption = t; await api(`/api/sessions/${S.cur}/frames/${f.id}`, { method: "PATCH", body: { caption: t } }); toast("Description saved", "ok"); }
});
$("#captureBtn").onclick = async () => {
  if (!S.cur || !video.getAttribute("src")) return;
  video.pause();
  try {
    const f = await api(`/api/sessions/${S.cur}/frames/capture`, { method: "POST", body: { t: video.currentTime } });
    S.frames.push(f); S.frames.sort((a, b) => a.t - b.t);
    $("#frameCount").textContent = S.frames.filter((x) => !x.hidden && x.kind !== "webcam").length;
    toast(`Captured the frame at ${ts(f.t)}`, "ok");
    if (S.tab === "frames") renderFrames();
    if (S.settings.vision_model) api(`/api/sessions/${S.cur}/frames/${f.id}/describe`, { method: "POST" }).then((r) => { Object.assign(f, r); if (S.tab === "frames") renderFrames(); }).catch(() => {});
  } catch (e) { toast(e.message, "err"); }
};
$("#recaptionBtn").onclick = () => { if (confirm("Describe every screenshot again with the vision model? Descriptions you typed are kept.")) resume("captions"); };
$("#redetectBtn").onclick = async () => {
  if (!confirm("Find screenshots again? The current ones, including any you captured, are replaced.")) return;
  const v = $("#sensSeg button.active")?.dataset.v || "medium";
  S.frames = []; renderFrames();
  await resume("frames", { frame_sensitivity: v });
};

// ------------------------------------------------------------------ meeting invite
async function loadInvite() {
  const r = await api(`/api/sessions/${S.cur}/invite`).catch(() => ({ invite: null }));
  S.invite = r.invite;
  if (S.tab === "invite") renderInvite();
}
function renderInvite() {
  const m = S.meta, inv = S.invite, busy = invBusy(m), b = `/api/sessions/${S.cur}/export`;
  const ready = m.stages?.transcript === "done";
  let h;
  if (busy) h = `<div class="empty"><b><span class="spin"></span> Drafting the invite</b>The assistant model is reading the summary and the action items.</div>`;
  else if (!inv) h = `<div class="empty"><b>No invite yet</b>${st(m, "invite") === "error" ? `<span class="warn-text">${esc(m.invite?.error || "The assistant stopped.")}</span><br>` : ""}
      A follow-up meeting with a subject, agenda, what to prepare and a ready-to-send body.<br><br>
      <button class="btn primary" id="invGen" ${ready ? "" : "disabled"}>${ready ? "Draft meeting invite" : "Waiting for the transcript"}</button></div>`;
  else {
    const agenda = (inv.agenda || []).map((a) => `<li>${esc(a.item)}${a.minutes ? ` <span class="muted">· ${a.minutes} min</span>` : ""}</li>`).join("");
    h = `<div class="toolbar"><button class="btn sm primary" id="invCopy">Copy invite</button>
        <a class="btn sm" href="${b}/invite.ics" download>Add to calendar (.ics)</a>
        <a class="btn sm" href="${b}/invite.txt" download>Save as text</a>
        <span class="spacer"></span><button class="btn sm" id="invGen">Draft again</button></div>
      <div class="out-grid">
        <div class="out-box"><h3>Subject</h3><input id="invSubject" value="${esc(inv.subject || "")}">
          <h3>Message</h3><textarea id="invBody" class="invite-body" rows="14">${esc(inv.body || "")}</textarea>
          <p class="help">Edits save by themselves. The calendar file opens at the next working day, 10:00; move it before you send.</p></div>
        <div class="out-box"><h3>Purpose</h3><p>${esc(inv.purpose || "")}</p>
          ${agenda ? `<h3>Agenda · ${inv.duration_minutes || S.settings.invite_duration || 30} min</h3><ol>${agenda}</ol>` : ""}
          ${inv.attendees?.length ? `<h3>Who to invite</h3><div class="chips">${inv.attendees.map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</div>` : ""}
          ${inv.prepare?.length ? `<h3>Ask them to prepare</h3><ul>${inv.prepare.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>
      </div>`;
  }
  $("#invitePane").innerHTML = h;
  const g = $("#invGen");
  if (g) g.onclick = async () => {
    if (inv && !confirm("Draft the invite again? Your edits to this one are replaced.")) return;
    try { await api(`/api/sessions/${S.cur}/invite/generate`, { method: "POST" }); S.meta.invite = { state: "queued" }; renderInvite(); renderMeta(); poll(); }
    catch (e) { toast(e.message, "err"); }
  };
  const c = $("#invCopy");
  if (c) c.onclick = async () => {
    try { await navigator.clipboard.writeText(`Subject: ${$("#invSubject").value}\n\n${$("#invBody").value}`); toast("Invite copied. Paste it into Outlook or Gmail.", "ok"); }
    catch { toast("Couldn't reach the clipboard", "err"); }
  };
  const save = debounce(async () => {
    S.invite = await api(`/api/sessions/${S.cur}/invite`, { method: "PUT", body: { subject: $("#invSubject").value, body: $("#invBody").value } });
  }, 700);
  $("#invSubject")?.addEventListener("input", save);
  $("#invBody")?.addEventListener("input", save);
}

// ------------------------------------------------------------------ Claude bundle
async function loadBundle() {
  const m = S.meta;
  if (!(S.transcript.segments || []).length) {
    $("#bundlePane").innerHTML = `<div class="empty"><b>${isBusy(m) ? '<span class="spin"></span> Waiting for the transcript' : "No transcript yet"}</b>The bundle needs the transcript first.</div>`;
    return;
  }
  try { S.bundle = await api(`/api/sessions/${S.cur}/bundle`); } catch (e) { toast(e.message, "err"); return; }
  renderBundle();
}
function renderBundle() {
  const bd = S.bundle, m = S.meta, d = st(m, "drive");
  const shots = bd.files.filter((f) => f.name.startsWith("screenshots/") && f.name.endsWith(".jpg"));
  const docs = bd.files.filter((f) => !f.name.startsWith("screenshots/") || f.name.endsWith(".md"));
  const total = bd.files.reduce((a, f) => a + f.bytes, 0);
  const driveLine = d === "done" ? `Copied to Drive › Pocket Scribe › Outputs. <button class="link-btn" id="openDrive">Open folder</button>`
    : d === "running" || d === "queued" ? '<span class="spin"></span> Copying to Google Drive' : d === "error" ? `<span class="warn-text">${esc(m.drive?.error || "Copy failed")}</span>` : "";
  $("#bundlePane").innerHTML = `
    <div class="out-grid">
      <div class="out-box">
        <h3>What should Claude build?</h3>
        <textarea id="bGoal" rows="3" placeholder="e.g. A PowerShell script that renews the IIS certificate the way the team showed, with a dry-run switch and a rollback.">${esc(bd.goal || "")}</textarea>
        <p class="help">This goes at the top of BRIEF.md. Leave it blank and Claude asks you.</p>
        <div class="row-gap">
          <a class="btn primary" href="/api/sessions/${S.cur}/export/bundle.zip" download>Download bundle (.zip)</a>
          <button class="btn" id="bCopy">Copy brief</button>
          <button class="btn" id="bDrive">Copy all outputs to Drive</button>
        </div>
        <p class="help">${driveLine}</p>
        <h3>How to use it</h3>
        <ol class="steps"><li>Download the bundle and unzip it.</li><li>In Claude, start a chat or a Cowork task and attach the folder's files (or the whole folder in Cowork).</li><li>Paste the brief as your first message.</li></ol>
      </div>
      <div class="out-box">
        <h3>In the bundle · ${kb(total)}</h3>
        <ul class="files">${docs.map((f) => `<li><span>${esc(f.name)}</span><em>${kb(f.bytes)}</em></li>`).join("")}
          <li><span>screenshots/ · ${shots.length} image${shots.length === 1 ? "" : "s"}</span><em>${kb(shots.reduce((a, f) => a + f.bytes, 0))}</em></li></ul>
        <h3>BRIEF.md</h3><article class="md brief">${md(bd.brief)}</article>
      </div>
    </div>`;
  const save = debounce(async () => {
    await api(`/api/sessions/${S.cur}`, { method: "PATCH", body: { bundle_goal: $("#bGoal").value } });
    const nb = await api(`/api/sessions/${S.cur}/bundle`); S.bundle.brief = nb.brief; S.bundle.goal = nb.goal;
    $(".brief").innerHTML = md(nb.brief);
  }, 700);
  $("#bGoal").addEventListener("input", save);
  $("#bCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(S.bundle.brief); toast("Brief copied", "ok"); } catch { toast("Couldn't reach the clipboard", "err"); }
  };
  $("#bDrive").onclick = async () => {
    try { await api(`/api/sessions/${S.cur}/drive`, { method: "POST" }); S.meta.drive = { state: "queued" }; renderBundle(); poll(); }
    catch (e) { toast(e.message, "err"); }
  };
  const od = $("#openDrive");
  if (od) od.onclick = () => api(`/api/sessions/${S.cur}/drive/open`, { method: "POST" }).catch((e) => toast(e.message, "err"));
}

// ------------------------------------------------------------------ Ask
async function loadChat() { S.chat = await api(`/api/sessions/${S.cur}/chat`).catch(() => []); if (S.tab === "ask") renderChat(); }
const SUGGEST = ["Walk me through the steps they showed", "List every server, URL, path and command mentioned",
  "What has to happen before the certificate expires?", "What could go wrong, and how do they fix it?", "What was left unclear that I should follow up on?"];
function renderChat() {
  $("#askModel").textContent = S.settings.assistant_model ? "Model: " + S.settings.assistant_model : "No assistant model yet. Pick one in Settings.";
  const box = $("#chat");
  if (!S.chat.length) {
    box.innerHTML = `<div class="empty"><b>Ask anything about this session</b>Answers come from the transcript and point to the moment it was said. Select a time to jump there.
      <div class="suggest">${SUGGEST.map((q) => `<button>${esc(q)}</button>`).join("")}</div></div>`;
    $$(".suggest button", box).forEach((b) => (b.onclick = () => ask(b.textContent)));
    return;
  }
  box.innerHTML = S.chat.map((m) => m.role === "user" ? `<div class="msg user">${esc(m.content)}</div>` :
    `<div class="msg bot"><div class="av">PS</div><div class="md">${md(m.content)}</div></div>`).join("");
  box.scrollTop = box.scrollHeight;
}
async function ask(q) {
  q = (q || "").trim(); if (!q || S.chatBusy) return;
  if (S.meta.stages?.transcript !== "done") { toast("Wait for the transcript to finish first", "err"); return; }
  S.chatBusy = true; $("#askBtn").disabled = true; $("#askInput").value = ""; autoGrow();
  if (!S.chat.length) $("#chat").innerHTML = "";
  S.chat.push({ role: "user", content: q });
  const box = $("#chat");
  box.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(q)}</div><div class="msg bot"><div class="av">PS</div><div class="md"><div class="thinking"><span class="spin"></span> Reading the session</div></div></div>`);
  const out = box.lastElementChild.querySelector(".md");
  box.scrollTop = box.scrollHeight;
  let text = "", thinking = 0;
  try {
    const r = await fetch(`/api/sessions/${S.cur}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.t === "content") { text += ev.d; out.innerHTML = md(text); }
        else if (ev.t === "thinking") { thinking += ev.d.length; if (!text) out.innerHTML = `<div class="thinking"><span class="spin"></span> Thinking · ${thinking.toLocaleString()} characters</div>`; }
        else if (ev.t === "error") throw new Error(ev.d);
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 140) box.scrollTop = box.scrollHeight;
      }
    }
    S.chat.push({ role: "assistant", content: text });
  } catch (e) {
    out.innerHTML = `<span class="warn-text">${esc(e.message)}</span>`;
    S.chat.pop();
  } finally { S.chatBusy = false; $("#askBtn").disabled = false; }
}
function autoGrow() { const t = $("#askInput"); t.style.height = "auto"; t.style.height = Math.min(180, t.scrollHeight) + "px"; }
$("#askInput").addEventListener("input", autoGrow);
$("#askInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask($("#askInput").value); } });
$("#askBtn").onclick = () => ask($("#askInput").value);
$("#clearChat").onclick = async () => { if (!S.chat.length || !confirm("Clear this conversation?")) return; await api(`/api/sessions/${S.cur}/chat`, { method: "DELETE" }); S.chat = []; renderChat(); };

// ------------------------------------------------------------------ polling
let pollTimer = null, polling = false, healthAt = 0, phoneAt = 0;
async function poll() {
  clearTimeout(pollTimer);
  if (polling) { pollTimer = setTimeout(poll, 400); return; }
  polling = true;
  let fast = false;
  try {
    if (S.cur) {
      const prev = S.meta;
      const m = await api(`/api/sessions/${S.cur}`).catch(() => null);
      if (m && m.id === S.cur) {
        S.meta = m;
        const g = m.stages || {}, pg = prev?.stages || {};
        if (g.transcript === "running" || (g.transcript === "done" && pg.transcript !== "done")) await loadTranscript();
        if ((g.frames === "done" && pg.frames !== "done") || g.captions === "running" || g.captions !== pg.captions) await loadFrames();
        if (g.summary === "done" && pg.summary !== "done") { await loadSummary(); if (S.tab === "transcript") renderTranscript(); }
        if (rbBusy(m) || (prev && rbBusy(prev))) await loadRunbook();
        if (prev && rbBusy(prev) && !rbBusy(m)) m.runbook.state === "done" ? toast("KT document ready", "ok") : m.runbook.state === "error" && toast("KT document stopped: " + m.runbook.error, "err");
        if (prev && invBusy(prev) && !invBusy(m)) { await loadInvite(); if (st(m, "invite") === "done") toast("Meeting invite ready", "ok"); else if (st(m, "invite") === "error") toast("Invite stopped: " + (m.invite.error || ""), "err"); }
        if (prev && st(prev, "drive") !== st(m, "drive") && S.tab === "bundle" && S.bundle) renderBundle();
        if (prev && st(prev, "drive") !== "done" && st(m, "drive") === "done") toast("Outputs copied to Google Drive", "ok");
        if (prev && isBusy(prev) && !isBusy(m)) {
          if (m.status === "ready") toast("Transcript, screenshots and summary ready", "ok"); else if (m.status === "error") toast("Stopped: " + m.error, "err");
          await Promise.all([loadTranscript(), loadFrames(), loadSummary()]);
        }
        renderMeta();
        if (S.tab === "runbook") renderRunbook();
        if (S.tab === "invite" && invBusy(m)) renderInvite();
      }
    }
    await loadSessions();
    fast = S.sessions.some(anyBusy);
    const now = Date.now();
    if (now - phoneAt > (fast ? 8000 : 15000)) { phoneAt = now; await loadPhone(); }
    if (now - healthAt > 30000) { healthAt = now; await checkHealth(); }
  } catch {}
  polling = false;
  pollTimer = setTimeout(poll, fast ? 1500 : 6000);
}

// ------------------------------------------------------------------ adding a recording
function upload(file, title, options) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    const q = new URLSearchParams({ filename: file.name, title, options: JSON.stringify(options) });
    x.open("POST", "/api/sessions/upload?" + q);
    const t0 = Date.now();
    $("#upload").hidden = false; $("#upBar").style.width = "0";
    x.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = e.loaded / e.total, mbps = e.loaded / 1e6 / ((Date.now() - t0) / 1000 || 1);
      $("#upBar").style.width = (p * 100).toFixed(1) + "%";
      $("#upText").textContent = `Copying ${file.name} · ${(p * 100).toFixed(0)}% · ${mbps.toFixed(0)} MB/s`;
    };
    x.onload = () => { $("#upload").hidden = true; x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(JSON.parse(x.responseText || "{}").detail || "Couldn't copy the file")); };
    x.onerror = () => { $("#upload").hidden = true; reject(new Error("Couldn't copy the file")); };
    x.send(file);
  });
}
function nextOptions() {
  const o = S.nextOptions, out = {};
  if (o.language) out.language = o.language;
  if (o.vocabulary) out.vocabulary = o.vocabulary;
  if (o.frame_sensitivity) out.frame_sensitivity = o.frame_sensitivity;
  return out;
}
async function started(m) {
  S.nextOptions.title = ""; $("#pathInput").value = "";
  toast(`Started “${m.title}”`, "ok");
  await loadSessions(); poll();
}
async function addFile(file) {
  if (!file) return;
  try { await started(await upload(file, S.nextOptions.title, nextOptions())); }
  catch (e) { toast(e.message, "err"); }
}
async function addPath() {
  const path = $("#pathInput").value.trim().replace(/^"|"$/g, "");
  if (!path) return $("#fileInput").click();
  try { await started(await api("/api/sessions/import", { method: "POST", body: { path, title: S.nextOptions.title, options: nextOptions() } })); }
  catch (e) { toast(e.message, "err"); }
}
$("#browseBtn").onclick = () => ($("#pathInput").value.trim() ? addPath() : $("#fileInput").click());
$("#pathInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addPath(); });
$("#fileInput").onchange = (e) => { addFile(e.target.files[0]); e.target.value = ""; };
$("#drop").addEventListener("click", (e) => { if (e.target !== $("#pathInput")) $("#fileInput").click(); });
for (const z of [$("#drop"), document.body]) {
  z.addEventListener("dragover", (e) => { if (!e.dataTransfer?.types.includes("Files")) return; e.preventDefault(); $("#drop").classList.add("over"); });
  z.addEventListener("dragleave", (e) => { if (e.target === $("#drop") || e.target === document.body) $("#drop").classList.remove("over"); });
  z.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); e.stopPropagation(); $("#drop").classList.remove("over");
    if (!$("#sessionSheet").hidden) return;
    addFile(e.dataTransfer.files[0]);
  });
}
$("#optionsBtn").onclick = () => {
  const o = S.nextOptions;
  $("#optTitle").value = o.title; $("#optLang").value = o.language || S.settings.language || "auto";
  $("#optVocab").value = o.vocabulary || S.settings.vocabulary || "";
  const v = o.frame_sensitivity || S.settings.frame_sensitivity || "medium";
  $$("#optSens button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  $("#optDialog").showModal();
};
$("#optSens").onclick = (e) => { const b = e.target.closest("button"); if (b) $$("#optSens button").forEach((x) => x.classList.toggle("active", x === b)); };
$("#optDialog").addEventListener("close", () => {
  S.nextOptions = { title: $("#optTitle").value.trim(), language: $("#optLang").value, vocabulary: $("#optVocab").value.trim(),
    frame_sensitivity: $("#optSens button.active")?.dataset.v || "" };
  $("#optionsBtn").classList.toggle("set", !!S.nextOptions.title);
});

// ------------------------------------------------------------------ settings
let savedTimer;
async function saveSetting(key, value) { return saveSettings({ [key]: value }); }
async function saveSettings(body) {
  try {
    S.settings = await api("/api/settings", { method: "PUT", body });
    clearTimeout(savedTimer); $("#savedNote").textContent = "Saved"; $("#savedNote").classList.add("on");
    savedTimer = setTimeout(() => $("#savedNote").classList.remove("on"), 1400);
    return S.settings;
  } catch (e) { toast("Couldn't save: " + e.message, "err"); }
}
const body = $("#settingsBody");
function fillSettings() {
  const s = S.settings;
  $$("[data-key]", body).forEach((el) => {
    if (el === document.activeElement) return;
    const v = s[el.dataset.key];
    if (el.type === "checkbox") el.checked = !!v; else if (el.tagName !== "SELECT" || !el.id.startsWith("s")) el.value = v ?? "";
  });
  $$("[data-segkey]", body).forEach((seg) => {
    const v = String(s[seg.dataset.segkey] ?? "");
    $$("button", seg).forEach((b) => b.classList.toggle("active", b.dataset.v === v));
  });
  $$("[data-prov]", body).forEach((el) => (el.hidden = el.dataset.prov !== (s.llm_provider || "ollama")));
  $$("[data-asr]", body).forEach((el) => (el.hidden = el.dataset.asr !== s.asr_engine));
  $("#anthropicKeyNote").textContent = s.anthropic_key_set ? "A key is saved. Paste a new one to replace it." : "No key saved yet.";
  $("#openaiKeyNote").textContent = s.openai_key_set ? "A key is saved. Paste a new one to replace it." : "";
  if (document.activeElement !== $("#phoneFolder")) $("#phoneFolder").value = s.phone_recordings_folder || "";
  $("#folderNote").textContent = S.phone?.folderAvailable ? `Using ${S.phone.folder}` : s.phone_recordings_folder ? "That folder isn't reachable right now." : "Not found yet. Install Google Drive for desktop, or paste the folder here.";
}
function fillModels(models) {
  const s = S.settings;
  const opts = (sel, wantVision) => `<option value="">None</option>` + models.map((m) => {
    const vis = m.capabilities?.includes("vision");
    const tag = [m.size_gb ? m.size_gb + " GB" : "", vis ? "vision" : "", m.capabilities?.includes("thinking") ? "reasoning" : ""].filter(Boolean).join(" · ");
    return `<option value="${esc(m.name)}" ${m.name === sel ? "selected" : ""} ${wantVision && !vis ? 'class="novis"' : ""}>${esc(m.name)}${tag ? " · " + tag : ""}</option>`;
  }).join("") + (sel && !models.some((m) => m.name === sel) ? `<option value="${esc(sel)}" selected>${esc(sel)} (not found)</option>` : "");
  $("#sWriter").innerHTML = opts(s.writer_model); $("#sAssistant").innerHTML = opts(s.assistant_model); $("#sVision").innerHTML = opts(s.vision_model, true);
}
async function loadModels(say) {
  $("#testOut").innerHTML = '<span class="spin"></span> Connecting';
  try {
    const r = await api("/api/settings/models");
    fillModels(r.models);
    $("#testOut").textContent = `Connected · ${r.models.length} model${r.models.length === 1 ? "" : "s"}`;
    if (say) checkHealth();
  } catch (e) { fillModels([]); $("#testOut").innerHTML = `<span class="warn-text">${esc(e.message)}</span>`; }
}
async function openSettings() {
  await checkHealth();
  fillSettings(); fillModels(S.health?.models || []);
  $("#testOut").textContent = S.health?.ollama ? `Connected · ${S.health.engine}` : S.health?.ollama_error || "";
  openSheet($("#settingsSheet"));
  try { S.defaults = await api("/api/settings/default-template"); } catch {}
}
function closeSettings() { closeSheet($("#settingsSheet")); checkHealth(); renderPhone(); }
$("#settingsBtn").onclick = openSettings;
const saveTextSoon = {};
body.addEventListener("change", (e) => {
  const el = e.target.closest("[data-key]"); if (!el) return;
  const key = el.dataset.key;
  if (el.type === "checkbox") { saveSetting(key, el.checked).then(() => { if (key === "animations") applyAnim(el.checked); if (key === "auto_process_phone") renderPhone(); }); return; }
  if (el.tagName === "SELECT") { saveSetting(key, el.value); return; }
  saveSetting(key, el.type === "number" ? +el.value : el.value);
});
body.addEventListener("input", (e) => {
  const el = e.target.closest("[data-key]"); if (!el || el.tagName === "SELECT" || el.type === "checkbox") return;
  const key = el.dataset.key;
  (saveTextSoon[key] ||= debounce((v) => saveSetting(key, v), 800))(el.type === "number" ? +el.value : el.value);
});
body.addEventListener("click", async (e) => {
  const sb = e.target.closest("[data-segkey] button");
  if (sb) {
    const seg = sb.parentElement, key = seg.dataset.segkey;
    const v = seg.hasAttribute("data-num") ? +sb.dataset.v : sb.dataset.v;
    $$("button", seg).forEach((b) => b.classList.toggle("active", b === sb));
    await saveSetting(key, v);
    if (key === "llm_provider") { fillSettings(); loadModels(true); }
    if (key === "asr_engine") fillSettings();
    if (key === "theme") applyTheme(v);
    return;
  }
  const kb2 = e.target.closest("[data-savekey]");
  if (kb2) {
    const f = kb2.dataset.savekey, input = f === "anthropic_key" ? $("#anthropicKey") : $("#openaiKey");
    const v = input.value.trim();
    if (f === "anthropic_key" && v && !v.startsWith("sk-ant-")) { toast("A Claude key starts with sk-ant-", "err"); return; }
    await saveSetting(f, v); input.value = "";
    toast(v ? "Key saved and encrypted" : "Key removed", "ok");
    fillSettings(); loadModels(true);
    return;
  }
  const tb = e.target.closest("[data-test]");
  if (tb) {
    const model = $("#" + tb.dataset.test).value;
    if (!model) { $("#testOut").textContent = "Pick a model first."; return; }
    $("#testOut").innerHTML = `<span class="spin"></span> Asking ${esc(model)}`;
    try { const r = await api("/api/settings/test-model", { method: "POST", body: { model } }); $("#testOut").textContent = `${model} replied “${r.reply}” in ${r.seconds} s`; }
    catch (err) { $("#testOut").innerHTML = `<span class="warn-text">${esc(err.message)}</span>`; }
    return;
  }
  const rb = e.target.closest("[data-reset]");
  if (rb) {
    const key = rb.dataset.reset, v = S.defaults[key];
    if (!v || !confirm("Put back the original text? Your changes are replaced.")) return;
    $(`[data-key="${key}"]`, body).value = v; await saveSetting(key, v); toast("Reset", "ok");
  }
});
$("#loadModelsBtn").onclick = () => loadModels(true);
$("#saveFolderBtn").onclick = async () => {
  try {
    await api("/api/phone-recordings/folder", { method: "PUT", body: { folder: $("#phoneFolder").value } });
    S.settings = await api("/api/settings");
    await loadPhone(); fillSettings(); toast("Folder saved", "ok");
  } catch (e) { $("#folderNote").innerHTML = `<span class="warn-text">${esc(e.message)}</span>`; }
};
$("#quitBtn").onclick = async () => {
  if (!confirm("Quit Pocket Scribe? Work in progress stops and resumes next time you open it.")) return;
  await api("/api/quit", { method: "POST" }).catch(() => {});
  document.body.innerHTML = `<div class="quit-msg"><b>Pocket Scribe has stopped.</b><span>Open it again from the desktop shortcut.</span></div>`;
};

// ------------------------------------------------------------------ info
function renderInfo() {
  const h = S.health || {};
  $("#infoBody").innerHTML = `
  <div class="card set"><h3><i class="dot"></i>How it works</h3>
    <div class="how3">
      <div><b>1 · Record on the phone</b>Open Pocket Scribe on the phone, point it at the screen, and tap Record. It keeps recording with the screen off.</div>
      <div><b>2 · It syncs through Google Drive</b>When you stop, the phone uploads the recording to My Drive › Pocket Scribe. Google Drive for desktop brings it to this PC.</div>
      <div><b>3 · This PC does the rest</b>Speech to text, screenshots of every screen change, a summary, the KT document, a meeting invite and a bundle for Claude.</div>
    </div></div>
  <div class="card set"><h3><i class="dot"></i>What you get for each session</h3>
    <dl class="kv">
      <dt>Transcript</dt><dd>Every word with times. Select any line to jump the video there. Double-click to correct a word, or fix one everywhere with Find & replace.</dd>
      <dt>Screenshots</dt><dd>Kept each time the shared screen changes, with a short description. Webcam-only frames are hidden.</dd>
      <dt>KT document</dt><dd>A step-by-step document written from the transcript and screenshots. Edit it, then export Word, PDF or Markdown.</dd>
      <dt>Meeting invite</dt><dd>A follow-up meeting: subject, agenda, who to invite, what to prepare. Copy it, or open the .ics in Outlook.</dd>
      <dt>Claude bundle</dt><dd>A .zip with a brief, the transcript, the KT document and the screenshots. Give it to Claude to build the automation you saw.</dd>
      <dt>Ask</dt><dd>Ask questions about the session. Answers point to the moment it was said.</dd>
    </dl></div>
  <div class="card set"><h3><i class="dot"></i>The steps on each card</h3>
    <div class="rail big legend"><span class="node done"><i></i>Done</span><span class="line done"></span><span class="node running"><i></i>Working</span><span class="line"></span><span class="node turn"><i></i>Your turn</span><span class="line"></span><span class="node pending"><i></i>Not yet</span><span class="line"></span><span class="node error"><i></i>Stopped</span></div>
    <p class="help">A session moves along Audio, Transcript, Screenshots, Summary, KT document and Invite. Your turn means it's waiting for you to start that step.</p></div>
  <div class="card set"><h3><i class="dot"></i>Privacy</h3>
    <p>Recordings, transcripts and screenshots stay on this PC and in your own Google Drive. Speech to text always runs here.
    With Ollama or vLLM the AI runs on your own machines too. Only if you choose Claude in Settings do transcripts and screenshots go to Anthropic to write the outputs.</p></div>
  <div class="card set"><h3><i class="dot"></i>Shortcuts</h3>
    <dl class="kv small"><dt>Esc</dt><dd>Close the open panel</dd><dt>Enter in the path box</dt><dd>Add that file</dd><dt>Enter in transcript search</dt><dd>Next match (Shift for previous)</dd><dt>Shift+Enter in Ask</dt><dd>New line</dd></dl></div>
  <div class="card set"><h3><i class="dot"></i>This PC</h3>
    <dl class="kv small">
      <dt>AI</dt><dd>${esc(h.engine || "Unknown")} · ${h.ollama ? "connected" : "not reachable"}</dd>
      <dt>Models</dt><dd>Writer ${esc(S.settings.writer_model || "none")} · Assistant ${esc(S.settings.assistant_model || "none")} · Vision ${esc(S.settings.vision_model || "none")}</dd>
      <dt>Drive folder</dt><dd>${esc(h.drive_folder || "Not found")}</dd>
      <dt>ffmpeg</dt><dd>${h.ffmpeg ? "Ready" : "Missing"}</dd>
      <dt>Address</dt><dd>${esc(location.origin)}</dd>
    </dl></div>`;
}
$("#infoBtn").onclick = async () => { await checkHealth(); renderInfo(); openSheet($("#infoSheet")); };

// ------------------------------------------------------------------ start
(async function init() {
  await checkHealth();
  await Promise.all([loadSessions(), loadPhone()]);
  healthAt = phoneAt = Date.now();
  const id = location.hash.slice(1);
  if (id && S.sessions.some((m) => m.id === id)) openSession(id);
  poll();
})();

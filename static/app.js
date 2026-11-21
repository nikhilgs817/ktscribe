/* KT Scribe front-end — vanilla JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const S = {
  sessions: [], cur: null, meta: null, transcript: { segments: [] }, frames: [], summary: {},
  runbook: { text: "" }, chat: [], settings: {}, health: null, tab: "overview", rbMode: "preview",
  rbDirty: false, segIndex: [], lastLoaded: {}, chatBusy: false,
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
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
}
function ago(t) {
  const d = (Date.now() / 1000 - t);
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  return new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const isBusy = (m) => m && (m.status === "running" || m.status === "queued");
const rbBusy = (m) => m && ["running", "queued"].includes(m.runbook?.state);

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
  let html = marked.parse(text || "");
  return html.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_, t) => `<button class="tchip" data-t="${parseTs(t)}">${t}</button>`);
}
document.addEventListener("click", (e) => {
  const c = e.target.closest(".tchip, [data-seek]");
  if (c) { seek(+(c.dataset.t ?? c.dataset.seek)); return; }
  const z = e.target.closest("[data-zoom]");
  if (z) { $("#lightImg").src = z.src; $("#lightCap").textContent = z.alt || ""; $("#lightbox").hidden = false; }
});
$("#lightbox").onclick = () => ($("#lightbox").hidden = true);

// ------------------------------------------------------------------ video
const video = $("#video");
function seek(t) {
  if (t == null || isNaN(t)) return;
  if ($("#svBody").classList.contains("focus")) setFocus(false);
  video.currentTime = Math.max(0, t - 0.3);
  video.play().catch(() => {});
}
$("#rateSel").onchange = (e) => (video.playbackRate = +e.target.value);
video.addEventListener("error", () => {
  const m = S.meta;
  $("#playerMsg").hidden = false;
  $("#playerMsg").innerHTML = m && !m.video_path ? "Uploading…" :
    "The browser can't play this file (format or location).<br>Transcript, runbook and Q&A still work.";
});
video.addEventListener("loadeddata", () => ($("#playerMsg").hidden = true));
video.addEventListener("timeupdate", () => highlightNow(video.currentTime));

let lastNow = -1;
function highlightNow(t) {
  const idx = S.segIndex;
  if (!idx.length) return;
  let lo = 0, hi = idx.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (idx[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  const id = ans >= 0 ? idx[ans].id : -1;
  if (id === lastNow) return;
  $$(".seg-s.now").forEach((e) => e.classList.remove("now"));
  lastNow = id;
  const el = document.querySelector(`.seg-s[data-id="${id}"]`);
  if (el) {
    el.classList.add("now");
    if ($("#followToggle").checked && S.tab === "transcript" && !video.paused) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  $$(".chapter").forEach((c) => c.classList.remove("now"));
  const chs = $$(".chapter").filter((c) => +c.dataset.seek <= t + 1);
  if (chs.length) chs[chs.length - 1].classList.add("now");
}

// ------------------------------------------------------------------ sidebar
async function loadSessions() {
  try { S.sessions = await api("/api/sessions"); } catch { return; }
  renderSessions();
}
function statusPill(m) {
  if (m.status === "running") return `<span class="pill run"><span class="spin"></span>${Math.round((m.progress || 0) * 100)}%</span>`;
  if (m.status === "queued") return `<span class="pill run">Queued</span>`;
  if (m.status === "error") return `<span class="pill err">Error</span>`;
  if (m.status === "cancelled") return `<span class="pill">Cancelled</span>`;
  if (rbBusy(m)) return `<span class="pill run"><span class="spin"></span>Runbook</span>`;
  return "";
}
function renderSessions() {
  const f = $("#sessionFilter").value.toLowerCase();
  const list = S.sessions.filter((m) => !f || (m.title || "").toLowerCase().includes(f));
  $("#sessionList").innerHTML = list.length ? list.map((m) => `
    <div class="s-item ${m.id === S.cur ? "active" : ""}" data-id="${m.id}">
      <div class="s-title">${esc(m.title || "Untitled")}</div>
      <div class="s-sub">${ago(m.created)}${m.duration ? " · " + dur(m.duration) : ""} <span class="spacer"></span>${statusPill(m)}</div>
      ${isBusy(m) ? `<div class="s-bar"><div style="width:${(m.progress || 0) * 100}%"></div></div>` : ""}
    </div>`).join("") : `<div class="muted small pad">${f ? "No matches" : "No sessions yet"}</div>`;
}
$("#sessionList").onclick = (e) => { const it = e.target.closest(".s-item"); if (it) openSession(it.dataset.id); };
$("#sessionFilter").oninput = renderSessions;

async function checkHealth() {
  try {
    const h = await api("/api/health");
    S.health = h; S.settings = h.settings;
    const ok = h.ollama && h.ffmpeg;
    $("#sysStatus").innerHTML = `<span class="dot ${ok ? "ok" : "err"}"></span><span title="${esc(h.ollama_error || h.ffmpeg_error || "")}">${
      !h.ffmpeg ? "ffmpeg missing" : !h.ollama ? "Ollama not reachable" : `Ollama · ${h.models.length} models`}</span>`;
  } catch { $("#sysStatus").innerHTML = `<span class="dot err"></span><span>Server offline</span>`; }
}

// ------------------------------------------------------------------ session view
async function openSession(id, tab) {
  if (S.rbDirty) await saveRunbook();
  S.cur = id; S.lastLoaded = {}; S.transcript = { segments: [] }; S.frames = []; S.summary = {}; S.chat = []; S.runbook = { text: "" };
  location.hash = id;
  $("#welcome").hidden = true; $("#sessionView").hidden = false;
  renderSessions();
  const m = await api(`/api/sessions/${id}`).catch(() => null);
  if (!m) { toast("Session not found", "err"); return showWelcome(); }
  S.meta = m;
  video.src = m.video_path ? `/api/sessions/${id}/video` : "";
  $("#playerMsg").hidden = true;
  await Promise.all([loadTranscript(), loadFrames(), loadSummary(), loadRunbook(), loadChat()]);
  renderMeta();
  switchTab(tab || (isBusy(m) ? "transcript" : S.tab));
}
function showWelcome() {
  S.cur = null; S.meta = null; location.hash = "";
  $("#welcome").hidden = false; $("#sessionView").hidden = true; video.removeAttribute("src"); renderSessions();
}

function renderMeta() {
  const m = S.meta; if (!m) return;
  if (document.activeElement !== $("#svTitle")) $("#svTitle").textContent = m.title || "Untitled";
  const segs = S.transcript.segments || [];
  const words = segs.reduce((a, s) => a + s.text.split(/\s+/).length, 0);
  $("#svMeta").innerHTML = [
    new Date(m.created * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    m.duration ? dur(m.duration) : "",
    words ? words.toLocaleString() + " words" : "",
    S.transcript.language ? "Language: " + S.transcript.language.toUpperCase() : "",
    m.video_copied === false ? `<span title="${esc(m.video_path)}">📁 linked file</span>` : "",
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");
  // progress strip
  const busy = isBusy(m);
  const showStrip = busy || m.status === "error" || m.status === "cancelled";
  $("#progressStrip").hidden = !showStrip;
  if (showStrip) {
    const icons = { pending: "○", running: '<span class="spin"></span>', done: "✓", error: "!", skipped: "–" };
    const labels = { audio: "Audio", transcript: "Transcript", frames: "Screenshots", captions: "Describe screenshots", summary: "Summary" };
    $("#stagePills").innerHTML = Object.entries(m.stages).map(([k, v]) => `<span class="stage ${v}"><i>${icons[v] || "○"}</i>${labels[k]}</span>`).join("");
    $("#progressBar").style.width = ((m.progress || 0) * 100).toFixed(1) + "%";
    $("#progressMsg").innerHTML = m.status === "error" ? `<span class="err">${esc(m.error || "Failed")}</span>` :
      m.status === "cancelled" ? "Cancelled." : esc(m.message || "") + (busy ? ` · ${Math.round((m.progress || 0) * 100)}%` : "");
    $("#cancelBtn").hidden = !busy; $("#resumeBtn").hidden = busy;
  }
  const w = m.warnings || [];
  $("#warnBanner").hidden = !w.length;
  $("#warnBanner").innerHTML = w.map((x) => "⚠ " + esc(x)).join("<br>") + (w.length ? ` &nbsp;<button class="link-btn" id="retryLLM">Retry</button>` : "");
  const rl = $("#retryLLM"); if (rl) rl.onclick = () => resume(w.some((x) => x.startsWith("Screenshot")) ? "captions" : "summary");
  $("#frameCount").textContent = S.frames.filter((f) => !f.hidden && f.kind !== "webcam").length || "";
  renderExportMenu();
  if (S.tab === "overview") renderOverview();
}

$("#svTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
$("#svTitle").addEventListener("blur", async (e) => {
  const t = e.target.textContent.trim();
  if (S.meta && t && t !== S.meta.title) { S.meta = await api(`/api/sessions/${S.cur}`, { method: "PATCH", body: { title: t } }); loadSessions(); }
});
$("#cancelBtn").onclick = async () => { await api(`/api/sessions/${S.cur}/cancel`, { method: "POST" }); toast("Cancelling…"); };
$("#resumeBtn").onclick = () => resume();
async function resume(redo) {
  S.meta = await api(`/api/sessions/${S.cur}/resume`, { method: "POST", body: redo ? { redo } : {} });
  renderMeta(); loadSessions();
}
$("#deleteBtn").onclick = async () => {
  if (!confirm(`Delete “${S.meta.title}”?\n\nThis removes its transcript, screenshots and runbook.` + (S.meta.video_copied ? " The copied video is deleted too." : " Your original video file is not touched."))) return;
  await api(`/api/sessions/${S.cur}`, { method: "DELETE" });
  toast("Session deleted"); showWelcome(); loadSessions();
};
function setFocus(on) {
  $("#svBody").classList.toggle("focus", on);
  $("#focusBtn").textContent = on ? "⇥ Show video" : "⇤ Focus";
}
$("#focusBtn").onclick = () => setFocus(!$("#svBody").classList.contains("focus"));

function renderExportMenu() {
  const b = `/api/sessions/${S.cur}/export`;
  const hasT = (S.transcript.segments || []).length, hasR = (S.runbook.text || "").trim(), hasS = S.summary && S.summary.summary;
  const item = (href, label, sub, ok) => ok ? `<a href="${href}" download>${label}<span>${sub}</span></a>` : "";
  $("#exportMenu").innerHTML = `
    <h6>Runbook</h6>${hasR ? item(`${b}/runbook.docx`, "Word document", ".docx", 1) + item(`${b}/runbook.pdf`, "PDF", ".pdf", 1) + item(`${b}/runbook.md`, "Markdown", ".md", 1) : `<div class="muted small pad">Generate a runbook first</div>`}
    <hr><h6>Transcript</h6>${hasT ? item(`${b}/transcript.docx`, "Word (with summary & chapters)", ".docx", 1) + item(`${b}/transcript.pdf`, "PDF", ".pdf", 1) + item(`${b}/transcript.txt`, "Plain text", ".txt", 1) + item(`${b}/transcript.srt`, "Subtitles", ".srt", 1) + item(`${b}/transcript.md`, "Markdown", ".md", 1) : `<div class="muted small pad">Not ready yet</div>`}
    ${hasS ? `<hr><h6>Summary</h6>${item(`${b}/summary.docx`, "Word document", ".docx", 1)}${item(`${b}/summary.pdf`, "PDF", ".pdf", 1)}` : ""}`;
}
$("#exportBtn").onclick = (e) => { e.stopPropagation(); renderExportMenu(); $("#exportMenu").hidden = !$("#exportMenu").hidden; };
document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) $("#exportMenu").hidden = true; });

// ------------------------------------------------------------------ tabs
$("#tabs").onclick = (e) => { const b = e.target.closest("button[data-tab]"); if (b) switchTab(b.dataset.tab); };
function switchTab(tab) {
  S.tab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".pane").forEach((p) => (p.hidden = p.dataset.pane !== tab));
  if (tab === "overview") renderOverview();
  if (tab === "transcript") renderTranscript();
  if (tab === "runbook") renderRunbook();
  if (tab === "frames") renderFrames();
  if (tab === "ask") renderChat();
}

// ------------------------------------------------------------------ overview
async function loadSummary() { S.summary = await api(`/api/sessions/${S.cur}/summary`).catch(() => ({})); renderChapters(); }
function renderChapters() {
  const chs = S.summary?.chapters || [];
  $("#chapterList").innerHTML = chs.length ? chs.map((c) => `<div class="chapter" data-seek="${parseTs(c.start) ?? 0}"><span class="t">${esc(c.start)}</span><div><b>${esc(c.title)}</b>${c.summary ? `<p>${esc(c.summary)}</p>` : ""}</div></div>`).join("")
    : `<div class="muted small pad">${isBusy(S.meta) ? "Appear after the summary is written." : "No chapters."}</div>`;
  lastNow = -2; highlightNow(video.currentTime || 0);
}
function renderOverview() {
  const m = S.meta, s = S.summary || {};
  const segs = S.transcript.segments || [];
  const shots = S.frames.filter((f) => !f.hidden && f.kind !== "webcam").length;
  const words = segs.reduce((a, x) => a + x.text.split(/\s+/).length, 0);
  const list = (arr) => `<ul>${arr.map((x) => `<li>${md(esc(x)).replace(/^<p>|<\/p>\s*$/g, "")}</li>`).join("")}</ul>`;
  let h = `<div class="ov">
    <div class="stat-row">
      <div class="stat"><b>${m.duration ? dur(m.duration) : "—"}</b><span>Recording</span></div>
      <div class="stat"><b>${words ? words.toLocaleString() : "—"}</b><span>Words transcribed</span></div>
      <div class="stat"><b>${shots || "—"}</b><span>Screenshots</span></div>
      <div class="stat"><b>${(S.runbook.text || "").trim() ? "Ready" : "—"}</b><span>Runbook</span></div>
    </div>
    <div class="quick">
      <button class="btn sm" data-go="transcript">📝 Read transcript</button>
      <button class="btn sm" data-go="runbook">${(S.runbook.text || "").trim() ? "📘 Open runbook" : "✨ Generate runbook"}</button>
      <button class="btn sm" data-go="ask">💬 Ask a question</button>
    </div>`;
  if (s.summary) {
    h += `<h3>Summary</h3><div class="lead">${esc(s.summary)}</div>`;
    if (s.key_points?.length) h += `<h3>Key points</h3>${list(s.key_points)}`;
    if (s.systems?.length) h += `<h3>Systems & tools mentioned</h3><div class="chips">${s.systems.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>`;
    h += `<div class="ov-grid" style="margin-top:18px">`;
    h += `<div class="ov-box"><h3>Action items</h3>${s.action_items?.length ? list(s.action_items) : '<div class="muted small">None noted</div>'}</div>`;
    h += `<div class="ov-box"><h3>Open questions</h3>${s.open_questions?.length ? list(s.open_questions) : '<div class="muted small">None noted</div>'}</div></div>`;
  } else if (isBusy(m)) {
    h += `<div class="empty"><b><span class="spin"></span> ${esc(m.message || "Working")}…</b>The transcript appears live in the Transcript tab. Summary and chapters follow when transcription finishes.</div>`;
  } else {
    h += `<div class="empty"><b>No summary yet</b>${m.stages?.summary === "error" ? "The summary step failed — check that Ollama is running, then " : ""}<button class="link-btn" id="redoSum">write the summary now</button>.</div>`;
  }
  h += "</div>";
  $("#overviewPane").innerHTML = h;
  $$("#overviewPane [data-go]").forEach((b) => (b.onclick = () => { switchTab(b.dataset.go); if (b.dataset.go === "runbook" && !(S.runbook.text || "").trim()) openGenPanel(); }));
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
function renderTranscript() {
  const segs = S.transcript.segments || [];
  const q = $("#tSearch").value.trim();
  const box = $("#transcript");
  const keepScroll = box.closest(".pane").scrollTop;
  if (!segs.length) {
    box.innerHTML = `<div class="empty"><b>${isBusy(S.meta) ? '<span class="spin"></span> Transcribing…' : "No transcript"}</b>${isBusy(S.meta) ? "Text will start appearing here in a moment." : ""}</div>`;
    $("#tStats").textContent = ""; return;
  }
  const chs = (S.summary?.chapters || []).map((c) => ({ t: parseTs(c.start) ?? 0, title: c.title }));
  let ci = 0;
  const re = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : null;
  let hits = 0;
  const html = blocks(segs, chs.map((c) => c.t)).map((b) => {
    let pre = "";
    while (ci < chs.length && chs[ci].t <= b.start + 1) { pre += `<div class="tchapter">${esc(chs[ci].title)}</div>`; ci++; }
    const inner = b.segs.map((s) => {
      let t = esc(s.text);
      if (re) t = t.replace(re, (mm) => { hits++; return `<mark>${mm}</mark>`; });
      return `<span class="seg-s" data-id="${s.id}" data-start="${s.start}">${t}</span>`;
    }).join(" ");
    return `${pre}<div class="tblock"><button class="ts" data-seek="${b.start}">${ts(b.start)}</button><p>${inner}</p></div>`;
  }).join("");
  box.innerHTML = html + (S.transcript.partial && isBusy(S.meta) ? `<div class="live-tail"><span class="spin"></span> Transcribing… ${Math.round((S.meta.progress || 0) * 100)}%</div>` : "");
  $("#tSearchCount").textContent = q ? `${hits} match${hits === 1 ? "" : "es"}` : "";
  const words = segs.reduce((a, s) => a + s.text.split(/\s+/).length, 0);
  $("#tStats").textContent = `${words.toLocaleString()} words · double-click text to correct it`;
  box.closest(".pane").scrollTop = keepScroll;
  lastNow = -1; highlightNow(video.currentTime);
  searchPos = -1;
}
let searchPos = -1;
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
  if (s && s.contentEditable !== "true" && !window.getSelection().toString() && e.detail === 1) {
    clearTimeout(s._t); s._t = setTimeout(() => seek(+s.dataset.start), 220);
  }
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
  toast(`Replaced ${r.count} occurrence${r.count === 1 ? "" : "s"}`, "ok");
  await loadTranscript();
};

// ------------------------------------------------------------------ runbook
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
  $("#rbPreview").innerHTML = (r.text || "").trim() ? md(r.text) : busy ? `<div class="empty"><b><span class="spin"></span> ${m.runbook?.state === "queued" ? "Waiting for the current job to finish…" : "The writer model is reading the session…"}</b>Text appears here as it's written. Large models can take a minute or two to start.</div>` : `<div class="empty"><b>No runbook yet</b>
      Generate one from the transcript and screenshots with <b style="display:inline">${esc(S.settings.writer_model || "the writer model")}</b>, then edit it here.<br><br>
      <button class="btn primary" id="genEmpty">✨ Generate runbook</button></div>`;
  const ge = $("#genEmpty"); if (ge) ge.onclick = openGenPanel;
  const st = m.runbook || {};
  const box = $("#rbStatus");
  if (busy) {
    box.hidden = false; box.className = "rb-status";
    box.innerHTML = `<span class="spin"></span> ${esc(st.phase || "Working")} ${st.chars ? `· ${st.chars.toLocaleString()} characters` : ""} <span class="spacer"></span><button class="btn sm ghost" id="rbCancel">Stop</button>`;
    $("#rbCancel").onclick = () => api(`/api/sessions/${S.cur}/runbook/cancel`, { method: "POST" });
  } else if (st.state === "error") {
    box.hidden = false; box.className = "rb-status err"; box.innerHTML = "⚠ " + esc(st.error || "Generation failed");
  } else box.hidden = true;
  $("#genBtn").disabled = busy;
  $("#genBtn").textContent = (r.text || "").trim() ? "✨ Regenerate" : "✨ Generate";
  $("#restoreBtn").hidden = !r.has_previous || busy;
  $("#rbSaved").textContent = busy ? "" : S.rbDirty ? "Unsaved changes…" : st.updated ? "Saved " + ago(st.updated) : "";
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
  } catch (e) { toast("Save failed: " + e.message, "err"); }
}
$("#rbEditor").addEventListener("input", () => {
  S.rbDirty = true; $("#rbSaved").textContent = "Unsaved changes…";
  $("#rbPreview").innerHTML = md($("#rbEditor").value);
  saveRunbookSoon();
});
function openGenPanel() {
  $("#genPanel").hidden = false;
  $("#genModel").textContent = `Writer: ${S.settings.writer_model || "not set"} · Screenshots: ${S.frames.filter((f) => !f.hidden && f.kind !== "webcam").length}` +
    ((S.runbook.text || "").trim() ? " · The current version is kept as “Previous version”." : "");
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
    setRbMode("preview"); renderRunbook(); poll();
  } catch (e) { toast(e.message, "err"); }
};
$("#restoreBtn").onclick = async () => {
  const r = await api(`/api/sessions/${S.cur}/runbook/restore`, { method: "POST" });
  S.runbook.text = r.text; renderRunbook(); toast("Swapped to the previous version");
};
$("#insertShotBtn").onclick = () => openPicker();
function openPicker() {
  const fr = S.frames.filter((f) => !f.hidden);
  $("#pickGrid").innerHTML = fr.length ? fr.map((f) => frameCard(f, true)).join("") : `<div class="empty"><b>No screenshots</b>Use “Capture frame” under the video.</div>`;
  $("#pickModal").hidden = false;
}
$("#pickGrid").onclick = (e) => {
  const c = e.target.closest(".fcard"); if (!c) return;
  const f = S.frames.find((x) => x.id === c.dataset.id);
  insertShot(f); $("#pickModal").hidden = true;
};
function insertShot(f) {
  if (S.rbMode === "preview") setRbMode("split");
  const ed = $("#rbEditor");
  const cap = (f.caption || `Screenshot at ${ts(f.t)}`).replace(/[\[\]]/g, "");
  const snippet = `\n\n![${cap}](frame:${f.id})\n\n`;
  const pos = ed.selectionStart ?? ed.value.length;
  ed.value = ed.value.slice(0, pos) + snippet + ed.value.slice(ed.selectionEnd ?? pos);
  ed.focus(); ed.selectionStart = ed.selectionEnd = pos + snippet.length;
  ed.dispatchEvent(new Event("input"));
  switchTab("runbook");
  toast("Screenshot inserted", "ok");
}

// ------------------------------------------------------------------ screenshots
async function loadFrames() {
  S.frames = await api(`/api/sessions/${S.cur}/frames`).catch(() => []);
  $("#frameCount").textContent = S.frames.filter((f) => !f.hidden && f.kind !== "webcam").length || "";
  if (S.tab === "frames") renderFrames();
}
function frameCard(f, picker = false) {
  const dim = f.hidden || f.kind === "webcam";
  return `<div class="fcard ${dim && !picker ? "dim" : ""}" data-id="${f.id}">
    <div class="fimg" ${picker ? "" : "data-zoomframe"}><img src="/api/sessions/${S.cur}/frames/${f.id}.jpg" loading="lazy" alt="${esc(f.caption)}">
      <span class="t"><button class="tchip" data-t="${f.t}">${ts(f.t)}</button></span>
      ${f.kind === "webcam" ? '<span class="badge">webcam</span>' : f.manual ? '<span class="badge">captured</span>' : ""}</div>
    <div class="fbody">
      ${picker ? `<div class="fcap">${esc(f.caption)}</div>` : `<div class="fcap" contenteditable="true" spellcheck="false">${esc(f.caption)}</div>
      <div class="factions">
        <button class="icon-btn" data-act="insert" title="Insert into runbook">➕</button>
        <button class="icon-btn" data-act="describe" title="Describe with vision model">✨</button>
        <button class="icon-btn" data-act="hide" title="${f.hidden ? "Unhide" : "Hide (exclude from runbook)"}">${f.hidden ? "👁" : "🙈"}</button>
        <span class="spacer"></span>
        <button class="icon-btn danger" data-act="delete" title="Delete">🗑</button>
      </div>`}
    </div></div>`;
}
function renderFrames() {
  const all = S.frames, show = $("#showHidden").checked;
  $("#sensSel").value = S.meta?.options?.frame_sensitivity || S.settings.frame_sensitivity || "medium";
  const fr = all.filter((f) => show || (!f.hidden && f.kind !== "webcam"));
  const hiddenN = all.length - all.filter((f) => !f.hidden && f.kind !== "webcam").length;
  $("#frameInfo").textContent = `${all.length - hiddenN} screenshots` + (hiddenN ? ` · ${hiddenN} hidden/webcam` : "");
  $("#frameGrid").innerHTML = fr.length ? fr.map((f) => frameCard(f)).join("") :
    `<div class="empty" style="grid-column:1/-1"><b>${S.meta.stages?.frames === "running" ? '<span class="spin"></span> Detecting screen changes…' : "No screenshots"}</b>
      ${S.meta.has_video === false ? "This is an audio-only file." : "Play the video and use “📸 Capture frame” to add your own."}</div>`;
}
$("#showHidden").onchange = renderFrames;
$("#frameGrid").addEventListener("click", async (e) => {
  const card = e.target.closest(".fcard"); if (!card) return;
  const f = S.frames.find((x) => x.id === card.dataset.id);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act && e.target.closest("[data-zoomframe]") && !e.target.closest(".tchip")) {
    $("#lightImg").src = `/api/sessions/${S.cur}/frames/${f.id}.jpg`; $("#lightCap").textContent = `${ts(f.t)} — ${f.caption || ""}`; $("#lightbox").hidden = false; return;
  }
  if (act === "insert") insertShot(f);
  if (act === "hide") { f.hidden = !f.hidden; await api(`/api/sessions/${S.cur}/frames/${f.id}`, { method: "PATCH", body: { hidden: f.hidden, kind: f.kind === "webcam" && !f.hidden ? "screen" : f.kind } }); if (!f.hidden && f.kind === "webcam") f.kind = "screen"; renderFrames(); }
  if (act === "delete") { if (!confirm("Delete this screenshot?")) return; await api(`/api/sessions/${S.cur}/frames/${f.id}`, { method: "DELETE" }); S.frames = S.frames.filter((x) => x !== f); renderFrames(); }
  if (act === "describe") {
    const b = e.target.closest("[data-act]"); b.innerHTML = '<span class="spin"></span>';
    try { Object.assign(f, await api(`/api/sessions/${S.cur}/frames/${f.id}/describe`, { method: "POST" })); renderFrames(); }
    catch (err) { toast(err.message, "err"); b.textContent = "✨"; }
  }
});
$("#frameGrid").addEventListener("focusout", async (e) => {
  const c = e.target.closest(".fcap"); if (!c) return;
  const f = S.frames.find((x) => x.id === c.closest(".fcard").dataset.id);
  const t = c.textContent.trim();
  if (f && t !== f.caption) { f.caption = t; await api(`/api/sessions/${S.cur}/frames/${f.id}`, { method: "PATCH", body: { caption: t } }); toast("Description saved", "ok"); }
});
$("#captureBtn").onclick = async () => {
  if (!S.cur || !video.src) return;
  video.pause();
  try {
    const f = await api(`/api/sessions/${S.cur}/frames/capture`, { method: "POST", body: { t: video.currentTime } });
    S.frames.push(f); S.frames.sort((a, b) => a.t - b.t);
    $("#frameCount").textContent = S.frames.filter((x) => !x.hidden && x.kind !== "webcam").length;
    toast(`Captured frame at ${ts(f.t)}`, "ok");
    if (S.tab === "frames") renderFrames();
    if (S.settings.vision_model) api(`/api/sessions/${S.cur}/frames/${f.id}/describe`, { method: "POST" }).then((r) => { Object.assign(f, r); if (S.tab === "frames") renderFrames(); }).catch(() => {});
  } catch (e) { toast(e.message, "err"); }
};
$("#recaptionBtn").onclick = async () => { if (confirm("Describe every screenshot again with the vision model? Manual descriptions are kept.")) resume("captions"); };
$("#redetectBtn").onclick = async () => {
  if (!confirm("Detect screenshots again? Current screenshots (including captured ones) are replaced.")) return;
  S.meta = await api(`/api/sessions/${S.cur}/resume`, { method: "POST", body: { redo: "frames", options: { frame_sensitivity: $("#sensSel").value } } });
  S.frames = []; renderFrames(); renderMeta(); poll();
};

// ------------------------------------------------------------------ chat
async function loadChat() { S.chat = await api(`/api/sessions/${S.cur}/chat`).catch(() => []); if (S.tab === "ask") renderChat(); }
const SUGGEST = ["How is the application hosted on AWS?", "Walk me through the deployment steps", "How do we monitor it and what alerts exist?",
  "List every server, URL and repo mentioned", "What are the common issues and how are they fixed?", "What was left unclear that I should follow up on?"];
function renderChat() {
  $("#askModel").textContent = S.settings.assistant_model ? "Model: " + S.settings.assistant_model : "No assistant model selected — open Settings";
  const box = $("#chat");
  if (!S.chat.length) {
    box.innerHTML = `<div class="empty"><b>Ask anything about this session</b>Answers come from the transcript and cite the moment it was said — click a time to jump there.
      <div class="suggest">${SUGGEST.map((q) => `<button>${esc(q)}</button>`).join("")}</div></div>`;
    $$(".suggest button", box).forEach((b) => (b.onclick = () => ask(b.textContent)));
    return;
  }
  box.innerHTML = S.chat.map((m) => m.role === "user" ? `<div class="msg user">${esc(m.content)}</div>` :
    `<div class="msg bot"><div class="av">AI</div><div class="md">${md(m.content)}</div></div>`).join("");
  box.scrollTop = box.scrollHeight;
}
async function ask(q) {
  q = (q || "").trim(); if (!q || S.chatBusy) return;
  if (isBusy(S.meta) && S.meta.stages.transcript !== "done") { toast("Wait for the transcript to finish first", "err"); return; }
  S.chatBusy = true; $("#askBtn").disabled = true; $("#askInput").value = ""; autoGrow();
  if (!S.chat.length) $("#chat").innerHTML = "";
  S.chat.push({ role: "user", content: q });
  const box = $("#chat");
  box.insertAdjacentHTML("beforeend", `<div class="msg user">${esc(q)}</div><div class="msg bot"><div class="av">AI</div><div class="md"><div class="thinking"><span class="spin"></span> Reading the session…</div></div></div>`);
  const out = box.lastElementChild.querySelector(".md");
  box.scrollTop = box.scrollHeight;
  let text = "", thinking = 0;
  try {
    const r = await fetch(`/api/sessions/${S.cur}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) });
    if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
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
        else if (ev.t === "thinking") { thinking += ev.d.length; if (!text) out.innerHTML = `<div class="thinking"><span class="spin"></span> Thinking… (${thinking} chars)</div>`; }
        else if (ev.t === "error") throw new Error(ev.d);
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
        if (nearBottom) box.scrollTop = box.scrollHeight;
      }
    }
    S.chat.push({ role: "assistant", content: text });
  } catch (e) {
    out.innerHTML = `<span class="err">⚠ ${esc(e.message)}</span>`;
    S.chat.pop();
  } finally { S.chatBusy = false; $("#askBtn").disabled = false; }
}
function autoGrow() { const t = $("#askInput"); t.style.height = "auto"; t.style.height = Math.min(180, t.scrollHeight) + "px"; }
$("#askInput").addEventListener("input", autoGrow);
$("#askInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask($("#askInput").value); } });
$("#askBtn").onclick = () => ask($("#askInput").value);
$("#clearChat").onclick = async () => { if (!S.chat.length || !confirm("Clear this conversation?")) return; await api(`/api/sessions/${S.cur}/chat`, { method: "DELETE" }); S.chat = []; renderChat(); };

// ------------------------------------------------------------------ polling
let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  let fast = false;
  try {
    if (S.cur) {
      const prev = S.meta;
      const m = await api(`/api/sessions/${S.cur}`);
      if (m.id !== S.cur) return;
      S.meta = m;
      const busy = isBusy(m), rb = rbBusy(m);
      fast = busy || rb;
      const st = m.stages || {}, pst = prev?.stages || {};
      if (st.transcript === "running" || (st.transcript === "done" && pst.transcript !== "done")) await loadTranscript();
      if ((st.frames === "done" && pst.frames !== "done") || st.captions === "running" || (st.captions !== pst.captions)) await loadFrames();
      if (st.summary === "done" && pst.summary !== "done") { await loadSummary(); if (S.tab === "transcript") renderTranscript(); }
      if (rb || (prev && rbBusy(prev) && !rb)) await loadRunbook();
      if (prev && rbBusy(prev) && !rb) {
        if (m.runbook.state === "done") toast("Runbook ready", "ok"); else if (m.runbook.state === "error") toast("Runbook failed: " + m.runbook.error, "err");
      }
      if (prev && isBusy(prev) && !busy) {
        if (m.status === "ready") toast("Processing complete", "ok"); else if (m.status === "error") toast("Processing failed: " + m.error, "err");
        await Promise.all([loadTranscript(), loadFrames(), loadSummary()]);
      }
      renderMeta();
      if (S.tab === "runbook") renderRunbook();
    }
    await loadSessions();
    if (S.sessions.some((x) => isBusy(x) || rbBusy(x))) fast = true;
  } catch {}
  pollTimer = setTimeout(poll, fast ? 1500 : 8000);
}

// ------------------------------------------------------------------ new session
let pickedFile = null, srcMode = "upload";
function openNew(mode = "upload") {
  pickedFile = null; $("#fileInput").value = ""; $("#pathInput").value = ""; $("#titleInput").value = ""; $("#newErr").textContent = "";
  $("#dropLabel").innerHTML = `<b>Drop a recording here</b> or <a href="#" id="browse">browse</a>`;
  $("#upProg").hidden = true; $("#startBtn").disabled = false;
  $("#optVocab").value = S.settings.vocabulary || ""; $("#optSens").value = S.settings.frame_sensitivity || "medium";
  $("#optLang").value = S.settings.language || "auto"; $("#optDescribe").checked = S.settings.describe_frames !== false;
  setSrc(mode);
  $("#newModal").hidden = false;
}
function setSrc(mode) {
  srcMode = mode;
  $$("#srcMode button").forEach((b) => b.classList.toggle("active", b.dataset.src === mode));
  $("#srcUpload").hidden = mode !== "upload"; $("#srcPath").hidden = mode !== "path";
  if (mode === "path") setTimeout(() => $("#pathInput").focus(), 50);
}
$("#srcMode").onclick = (e) => { const b = e.target.closest("button"); if (b) setSrc(b.dataset.src); };
function pick(file) {
  if (!file) return;
  pickedFile = file;
  $("#dropLabel").innerHTML = `<b>${esc(file.name)}</b> · ${(file.size / 1e6).toFixed(0)} MB &nbsp;<a href="#" id="browse">change</a>`;
  if (!$("#titleInput").value) $("#titleInput").placeholder = file.name.replace(/\.[^.]+$/, "");
}
$("#newBtn").onclick = () => openNew();
$("#welcomeBrowse").onclick = (e) => { e.preventDefault(); e.stopPropagation(); openNew(); $("#fileInput").click(); };
$("#welcomePath").onclick = (e) => { e.preventDefault(); e.stopPropagation(); openNew("path"); };
$("#welcomeDrop").onclick = () => { openNew(); $("#fileInput").click(); };
$("#drop").onclick = (e) => { e.preventDefault(); $("#fileInput").click(); };
$("#fileInput").onchange = (e) => pick(e.target.files[0]);
for (const z of [$("#drop"), $("#welcomeDrop")]) {
  z.addEventListener("dragover", (e) => { e.preventDefault(); z.classList.add("over"); });
  z.addEventListener("dragleave", () => z.classList.remove("over"));
  z.addEventListener("drop", (e) => {
    e.preventDefault(); z.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (z.id === "welcomeDrop") openNew();
    pick(f);
  });
}
$("#startBtn").onclick = async () => {
  $("#newErr").textContent = "";
  const options = { language: $("#optLang").value, vocabulary: $("#optVocab").value, frame_sensitivity: $("#optSens").value, describe_frames: $("#optDescribe").checked };
  const title = $("#titleInput").value.trim();
  try {
    let m;
    if (srcMode === "path") {
      const path = $("#pathInput").value.trim();
      if (!path) { $("#newErr").textContent = "Enter the file path"; return; }
      m = await api("/api/sessions/import", { method: "POST", body: { path, title, options } });
    } else {
      if (!pickedFile) { $("#newErr").textContent = "Choose a file first"; return; }
      $("#startBtn").disabled = true; $("#upProg").hidden = false;
      m = await upload(pickedFile, title, options);
    }
    $("#newModal").hidden = true;
    await loadSessions(); openSession(m.id, "transcript"); poll();
  } catch (e) { $("#newErr").textContent = e.message; $("#startBtn").disabled = false; }
};
function upload(file, title, options) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    const q = new URLSearchParams({ filename: file.name, title, options: JSON.stringify(options) });
    x.open("POST", "/api/sessions/upload?" + q);
    const t0 = Date.now();
    x.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const p = e.loaded / e.total, mbps = e.loaded / 1e6 / ((Date.now() - t0) / 1000 || 1);
      $("#upBar").style.width = (p * 100).toFixed(1) + "%";
      $("#upText").textContent = `Copying into library… ${(p * 100).toFixed(0)}% · ${mbps.toFixed(0)} MB/s`;
    };
    x.onload = () => (x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(JSON.parse(x.responseText || "{}").detail || "Upload failed")));
    x.onerror = () => reject(new Error("Upload failed"));
    x.send(file);
  });
}

// ------------------------------------------------------------------ settings
const SET_FIELDS = { sOllama: "ollama_url", sWriter: "writer_model", sAssistant: "assistant_model", sVision: "vision_model", sEffort: "writer_reasoning",
  sCtx: "max_context", sEngine: "asr_engine", sWModel: "whisper_model", sBeam: "whisper_beam", sThreads: "whisper_threads", sWcppExe: "whispercpp_exe",
  sWcppModel: "whispercpp_model", sVocab: "vocabulary", sSens: "frame_sensitivity", sMaxFrames: "max_frames", sTemplate: "runbook_template" };
let DEFAULT_TPL = null;
async function openSettings() {
  await checkHealth();
  const s = S.settings, h = S.health || {};
  if (DEFAULT_TPL === null) DEFAULT_TPL = s.runbook_template;
  const models = h.models || [];
  const opts = (sel, vis) => `<option value="">— none —</option>` + models.map((m) => `<option value="${esc(m.name)}" ${m.name === sel ? "selected" : ""}>${esc(m.name)} · ${m.size_gb} GB${m.capabilities?.includes("vision") ? " · 👁 vision" : ""}${m.capabilities?.includes("thinking") ? " · reasoning" : ""}</option>`).join("") +
    (sel && !models.some((m) => m.name === sel) ? `<option value="${esc(sel)}" selected>${esc(sel)} (not found)</option>` : "");
  $("#sWriter").innerHTML = opts(s.writer_model); $("#sAssistant").innerHTML = opts(s.assistant_model); $("#sVision").innerHTML = opts(s.vision_model);
  for (const [id, key] of Object.entries(SET_FIELDS)) { if (!["sWriter", "sAssistant", "sVision"].includes(id)) $("#" + id).value = s[key] ?? ""; }
  $("#sDescribe").checked = !!s.describe_frames;
  $("#ollamaPill").className = "pill " + (h.ollama ? "ok" : "err");
  $("#ollamaPill").textContent = h.ollama ? `connected · ${models.length} models` : "not reachable";
  $("#testOut").textContent = h.ollama ? "" : (h.ollama_error || "");
  $("#wcppFields").hidden = $("#sEngine").value !== "whisper.cpp";
  $("#settingsModal").hidden = false;
}
$("#sEngine").onchange = () => ($("#wcppFields").hidden = $("#sEngine").value !== "whisper.cpp");
$("#settingsBtn").onclick = openSettings;
let DEFAULT_TPL_TEXT = null;
$("#resetTpl").onclick = () => { if (DEFAULT_TPL_TEXT) $("#sTemplate").value = DEFAULT_TPL_TEXT; };
$("#saveSettings").onclick = async () => {
  const body = {};
  for (const [id, key] of Object.entries(SET_FIELDS)) body[key] = $("#" + id).value;
  body.max_context = +body.max_context; body.whisper_beam = +body.whisper_beam; body.whisper_threads = +body.whisper_threads || 0; body.max_frames = +body.max_frames || 150;
  body.describe_frames = $("#sDescribe").checked;
  S.settings = await api("/api/settings", { method: "PUT", body });
  $("#settingsModal").hidden = true; toast("Settings saved", "ok"); checkHealth();
};
$$("[data-test]").forEach((b) => (b.onclick = async () => {
  const model = $("#" + b.dataset.test).value; if (!model) return;
  $("#testOut").innerHTML = `<span class="spin"></span> Loading ${esc(model)}… (first load of a large model can take a minute)`;
  try { const r = await api("/api/settings/test-model", { method: "POST", body: { model, role: b.dataset.role } }); $("#testOut").textContent = `✓ ${model} replied “${r.reply}” in ${r.seconds}s`; }
  catch (e) { $("#testOut").innerHTML = `<span class="err">✗ ${esc(e.message)}</span>`; }
}));

$("#quitBtn").onclick = async () => {
  const busy = S.sessions.some((x) => isBusy(x) || rbBusy(x));
  if (!confirm(busy ? "A job is still running. Quit anyway? (You can resume it next time.)" : "Quit KT Scribe? This stops the background server.")) return;
  if (S.rbDirty) await saveRunbook();
  clearTimeout(pollTimer);
  await fetch("/api/quit", { method: "POST" }).catch(() => {});
  document.body.innerHTML = `<div style="height:100vh;display:grid;place-items:center;text-align:center;color:#b8c0d0;font:15px system-ui"><div><h2 style="color:#e7eaf1">KT Scribe has stopped</h2>You can close this tab. Open KT Scribe from the desktop shortcut to start it again.</div></div>`;
};

// ------------------------------------------------------------------ modals & keys
$$(".modal").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.hidden = true; });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $$(".modal").forEach((m) => (m.hidden = true)); $("#lightbox").hidden = true; $("#exportMenu").hidden = true; }
  if ((e.ctrlKey || e.metaKey) && e.key === "s" && S.tab === "runbook") { e.preventDefault(); saveRunbook(); }
});
window.addEventListener("beforeunload", (e) => { if (S.rbDirty) { saveRunbook(); e.preventDefault(); } });

// ------------------------------------------------------------------ boot
(async function boot() {
  try { DEFAULT_TPL_TEXT = (await api("/api/settings/default-template").catch(() => null))?.template || null; } catch {}
  await checkHealth();
  await loadSessions();
  const id = location.hash.slice(1);
  if (id && S.sessions.some((s) => s.id === id)) openSession(id);
  else if (S.sessions.length) openSession(S.sessions[0].id);
  poll();
  setInterval(checkHealth, 30000);
})();

const phoneInbox = $("#phoneInbox");
let phoneInboxData = null;
let phoneInboxRequest = null;
let phoneProcessing = null;
const phoneStates = {
  available: "Ready to process", syncing: "Waiting for Drive sync", queued: "Queued",
  running: "Processing", ready: "Processed", error: "Needs attention", cancelled: "Processing stopped",
};

function phoneError(message = "") {
  $("#phoneInboxError").textContent = message;
  $("#phoneInboxError").hidden = !message;
}

function renderPhoneInbox() {
  const inbox = phoneInboxData;
  const unread = inbox?.recordings.filter((r) => r.state === "available").length || 0;
  $("#phoneInboxCount").textContent = unread;
  $("#phoneInboxCount").hidden = !unread;
  if (!phoneInbox.open) return;

  const folderStatus = $("#phoneFolderStatus");
  const list = $("#phoneRecordingList");
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.recording : null;
  list.replaceChildren();
  folderStatus.textContent = inbox?.folderAvailable ? inbox.folder
    : inbox?.folder ? "Drive folder unavailable" : "Connect Google Drive";
  if (!inbox?.recordings.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = inbox?.folderAvailable
      ? "No phone recordings yet. Save a recording in Pocket Scribe and it will appear here after Drive sync."
      : inbox ? "Open Google Drive for desktop on this PC, or choose the Pocket Scribe folder." : "Checking for recordings…";
    list.append(empty);
    return;
  }

  for (const rec of inbox.recordings) {
    const row = document.createElement("div");
    const info = document.createElement("div");
    const title = document.createElement("strong");
    const details = document.createElement("p");
    const date = new Date(rec.startedAt);
    const parts = [rec.mode === "audio_only" ? "Audio" : "Audio + video"];
    if (Number.isFinite(date.getTime())) parts.unshift(date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
    if (rec.durationMs > 0) parts.push(ts(rec.durationMs / 1000));
    parts.push(phoneStates[rec.state] || "Imported");
    row.className = "phone-recording";
    info.className = "phone-recording-info";
    title.textContent = rec.title;
    details.className = "small muted";
    details.textContent = parts.join(" · ");
    info.append(title, details);
    row.append(info);
    if (rec.sessionId || rec.state === "available") {
      const button = document.createElement("button");
      button.className = rec.sessionId ? "btn" : "btn primary";
      button.dataset.recording = rec.id;
      button.textContent = rec.sessionId ? "Open session" : phoneProcessing === rec.id ? "Importing…" : "Process";
      button.disabled = !rec.sessionId && phoneProcessing !== null;
      button.setAttribute("aria-label", button.textContent + " " + rec.title);
      button.onclick = () => openPhoneRecording(rec);
      row.append(button);
    }
    list.append(row);
  }
  if (focused) list.querySelector('[data-recording="' + focused + '"]')?.focus({ preventScroll: true });
}

async function refreshPhoneInbox() {
  if (phoneInboxRequest) return phoneInboxRequest;
  phoneInboxRequest = (async () => {
    try {
      const next = await api("/api/phone-recordings");
      if (JSON.stringify(next) !== JSON.stringify(phoneInboxData)) {
        phoneInboxData = next;
        renderPhoneInbox();
      }
    } catch (e) {
      if (phoneInbox.open) phoneError(e.message);
    } finally {
      phoneInboxRequest = null;
    }
  })();
  return phoneInboxRequest;
}

async function openPhoneRecording(rec) {
  phoneError();
  try {
    let id = rec.sessionId;
    if (!id) {
      if (phoneProcessing) return;
      phoneProcessing = rec.id;
      renderPhoneInbox();
      const session = await api("/api/phone-recordings/" + rec.id + "/process", { method: "POST", body: {} });
      id = session.id;
      await loadSessions();
    }
    phoneInbox.close();
    await openSession(id, "transcript");
    poll();
  } catch (e) {
    phoneError(e.message);
  } finally {
    if (phoneProcessing === rec.id) {
      phoneProcessing = null;
      renderPhoneInbox();
      await refreshPhoneInbox();
    }
  }
}

$("#phoneInboxBtn").onclick = () => {
  phoneError();
  phoneInbox.showModal();
  renderPhoneInbox();
  refreshPhoneInbox();
};
$("#closePhoneInbox").onclick = () => phoneInbox.close();
$("#refreshPhoneInbox").onclick = () => {
  phoneError();
  refreshPhoneInbox();
};
$("#editPhoneFolder").onclick = () => {
  const form = $("#phoneFolderForm");
  form.hidden = !form.hidden;
  $("#editPhoneFolder").setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) {
    $("#phoneFolder").value = phoneInboxData?.folder || "";
    $("#phoneFolder").focus();
  }
};
$("#phoneFolderForm").onsubmit = async (event) => {
  event.preventDefault();
  phoneError();
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/phone-recordings/folder", { method: "PUT", body: { folder: $("#phoneFolder").value } });
    $("#phoneFolderForm").hidden = true;
    $("#editPhoneFolder").setAttribute("aria-expanded", "false");
    $("#editPhoneFolder").focus();
    await phoneInboxRequest;
    await refreshPhoneInbox();
  } catch (e) {
    phoneError(e.message);
  } finally {
    button.disabled = false;
  }
};

refreshPhoneInbox();
setInterval(refreshPhoneInbox, 20000);

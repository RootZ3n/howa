// ══════════════════════════════════════════════════════════════════════
// HOWA · app.js — wires the live backend into the Arena world engine.
// Adds four things, mounted on <body> so the engine's render() never wipes
// them: a backend status dot, a command bar, Peh's Journal, and a scene
// launcher. Watches the engine's scene state and, on each move, has Peh
// greet you (peh-guide.js) and pulls real data for the area (scenes.js).
// Pure vanilla. Loads AFTER the engine + api/scenes/peh-guide.
// ══════════════════════════════════════════════════════════════════════
(function (global) {
  "use strict";

  const API = global.HowaAPI, SCENES = global.HowaScenes, PEH = global.PehGuide;
  const doc = global.document;
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ── Bridges to the engine (index.html). Guarded so a missing global is
  //    never fatal — the HUD degrades, it doesn't crash. ─────────────────
  // The engine declares `state` / `SCENE_REGISTRY` as top-level const — these
  // live in the shared global LEXICAL scope (not on window), so reach them by
  // bare identifier behind a typeof guard, never via global.*.
  function curScene() {
    try {
      if (typeof state !== "undefined" && state.pehverse) return state.pehverse.scene;
    } catch (e) { /* not loaded yet */ }
    return null;
  }
  function sceneList() {
    try {
      if (typeof SCENE_REGISTRY !== "undefined" && SCENE_REGISTRY.howa) return SCENE_REGISTRY.howa;
    } catch (e) { /* not loaded yet */ }
    return [];
  }
  function sceneTitle(id) {
    const s = sceneList().find((x) => x.id === id);
    return s ? s.title : (id || "—");
  }
  function travel(id) { if (typeof global.pehGoScene === "function") global.pehGoScene(id); }
  function openWs(id) { if (typeof global.pehOpenWorkspace === "function") global.pehOpenWorkspace(id); }

  // ── Journal: a capped, timestamped log of what happened. ──────────────
  const journal = [];
  const JOURNAL_MAX = 60;
  function clock() {
    const d = new Date();
    const p = (n) => (n < 10 ? "0" + n : "" + n);
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function logJournal(kind, text) {
    journal.push({ t: clock(), kind: kind, text: text });
    if (journal.length > JOURNAL_MAX) journal.splice(0, journal.length - JOURNAL_MAX);
    paintJournal();
  }

  // ── One-time style injection (namespaced, uses existing theme vars). ──
  function injectStyles() {
    if (doc.getElementById("howa-hud-style")) return;
    const css = `
.howa-hud{position:fixed;z-index:60;font-family:var(--body,system-ui,sans-serif);color:var(--ink,#f0ece4)}
.howa-status{top:10px;right:12px;display:flex;align-items:center;gap:8px;padding:6px 11px;border-radius:999px;
  background:var(--bg-card,rgba(22,20,32,.78));border:1px solid var(--bg-3,#24212e);font-size:12px;backdrop-filter:blur(6px)}
.howa-status-dot{width:9px;height:9px;border-radius:50%;background:#8a8;box-shadow:0 0 0 3px rgba(0,0,0,.25);transition:background .2s}
.howa-status.on .howa-status-dot{background:#3fb950;box-shadow:0 0 8px #3fb95088}
.howa-status.off .howa-status-dot{background:#d2403a;box-shadow:0 0 8px #d2403a88}
.howa-status b{font-weight:700}.howa-status i{font-style:normal;color:var(--ink-dim,#9a8e7a)}
.howa-peh{left:12px;bottom:64px;width:330px;max-width:calc(100vw - 24px);padding:13px 14px 12px;border-radius:14px;
  background:var(--bg-card,rgba(22,20,32,.92));border:1px solid var(--peh-accent,#dc2626);
  box-shadow:0 14px 40px rgba(0,0,0,.5);backdrop-filter:blur(8px)}
.howa-peh-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.howa-peh-name{font-family:var(--arena-display,serif);font-weight:700;color:var(--peh-accent,#dc2626);letter-spacing:.04em}
.howa-peh-where{margin-left:auto;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-dim,#9a8e7a)}
.howa-peh-say{font-size:13.5px;line-height:1.45;margin:0 0 8px}
.howa-peh-data{font-size:12px;color:var(--ink-soft,#d8d0c0);margin:0 0 9px}
.howa-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.howa-chip{font-size:11px;padding:3px 8px;border-radius:7px;background:var(--bg-2,#1a1826);border:1px solid var(--bg-3,#24212e)}
.howa-chip b{color:var(--ink,#f0ece4)}.howa-chip.warn b{color:#e8a13a}
.howa-peh-opts{display:flex;flex-wrap:wrap;gap:6px}
.howa-opt{cursor:pointer;font-size:12px;padding:5px 10px;border-radius:8px;color:var(--ink,#f0ece4);
  background:var(--bg-2,#1a1826);border:1px solid var(--bg-3,#24212e);transition:border-color .15s,background .15s}
.howa-opt:hover{border-color:var(--peh-accent,#dc2626);background:var(--bg-card-hover,rgba(30,27,42,.88))}
.howa-bar{left:50%;transform:translateX(-50%);bottom:12px;display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:12px;
  background:var(--bg-card,rgba(22,20,32,.92));border:1px solid var(--bg-3,#24212e);box-shadow:0 10px 30px rgba(0,0,0,.45);width:min(560px,calc(100vw - 24px))}
.howa-bar input{flex:1;background:var(--bg-0,#0a0a0c);border:1px solid var(--bg-3,#24212e);border-radius:8px;
  color:var(--ink,#f0ece4);font-size:13px;padding:7px 10px;outline:none}
.howa-bar input:focus{border-color:var(--peh-accent,#dc2626)}
.howa-bar-btn{cursor:pointer;font-size:12px;padding:7px 9px;border-radius:8px;color:var(--ink,#f0ece4);
  background:var(--bg-2,#1a1826);border:1px solid var(--bg-3,#24212e)}
.howa-bar-btn:hover{border-color:var(--peh-accent,#dc2626)}
.howa-launch{display:flex;gap:5px}
.howa-jrn{right:12px;bottom:64px;width:300px;max-width:calc(100vw - 24px);max-height:46vh;display:none;flex-direction:column;
  border-radius:14px;background:var(--bg-card,rgba(22,20,32,.95));border:1px solid var(--bg-3,#24212e);box-shadow:0 14px 40px rgba(0,0,0,.5)}
.howa-jrn.open{display:flex}
.howa-jrn-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--bg-3,#24212e)}
.howa-jrn-head b{font-family:var(--arena-display,serif);color:var(--peh-accent,#dc2626)}
.howa-jrn-x{margin-left:auto;cursor:pointer;background:none;border:0;color:var(--ink-dim,#9a8e7a);font-size:16px}
.howa-jrn-body{overflow-y:auto;padding:8px 12px;font-size:12px;line-height:1.5}
.howa-jrn-row{display:flex;gap:8px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.howa-jrn-row time{color:var(--ink-dim,#9a8e7a);flex:0 0 auto;font-variant-numeric:tabular-nums}
.howa-jrn-row .k{color:var(--peh-accent,#dc2626);flex:0 0 auto;text-transform:uppercase;font-size:10px;align-self:center}
@media(max-width:640px){.howa-peh,.howa-jrn{bottom:58px}.howa-status b{display:none}}`;
    const st = doc.createElement("style");
    st.id = "howa-hud-style";
    st.textContent = css;
    doc.head.appendChild(st);
  }

  // ── DOM scaffold ──────────────────────────────────────────────────────
  let elStatus, elPeh, elJournal, elBarInput;
  function build() {
    elStatus = mount(`<div class="howa-hud howa-status" title="Backend ${esc(API.base)}">
      <span class="howa-status-dot"></span><b>Backend</b><i>checking…</i></div>`);
    elPeh = mount(`<div class="howa-hud howa-peh" role="status"></div>`);
    elJournal = mount(`<aside class="howa-hud howa-jrn" aria-label="Peh's Journal">
      <div class="howa-jrn-head"><b>Peh's Journal</b><span style="font-size:11px;color:var(--ink-dim)">session log</span>
      <button class="howa-jrn-x" title="Close" aria-label="Close journal">×</button></div>
      <div class="howa-jrn-body"></div></aside>`);
    elJournal.querySelector(".howa-jrn-x").onclick = () => elJournal.classList.remove("open");

    const launch = sceneList().map((s) =>
      `<button class="howa-bar-btn howa-jump" data-scene="${esc(s.id)}" title="Travel to ${esc(s.title)}">${esc(s.title.split(" ").pop())}</button>`
    ).join("");
    const bar = mount(`<div class="howa-hud howa-bar">
      <input type="text" placeholder="Command Peh:  go arena · open stress-tests · refresh · journal · help" aria-label="Command bar">
      <span class="howa-launch">${launch}</span>
      <button class="howa-bar-btn" data-cmd="journal" title="Toggle Peh's Journal">📓</button></div>`);
    elBarInput = bar.querySelector("input");
    elBarInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { runCommand(elBarInput.value); elBarInput.value = ""; }
    });
    bar.querySelector('[data-cmd="journal"]').onclick = () => toggleJournal();
    bar.querySelectorAll(".howa-jump").forEach((b) =>
      b.addEventListener("click", () => travel(b.getAttribute("data-scene"))));
  }
  function mount(html) {
    const wrap = doc.createElement("div");
    wrap.innerHTML = html.trim();
    const el = wrap.firstChild;
    doc.body.appendChild(el);
    return el;
  }

  // ── Status dot — poll health. ─────────────────────────────────────────
  async function refreshStatus() {
    const r = await API.health();
    if (!elStatus) return;
    elStatus.classList.toggle("on", r.ok);
    elStatus.classList.toggle("off", !r.ok);
    const v = (r.data && r.data.version) ? "v" + r.data.version : "";
    elStatus.querySelector("i").textContent = r.ok ? ("online " + v) : "offline";
  }

  // ── Peh panel — greeting + live remark + stats + options. ─────────────
  async function paintPeh(sceneId, nth) {
    if (!elPeh || !PEH) return;
    const guide = PEH.forScene(sceneId, nth);
    const opts = guide.options.map((o, i) =>
      `<button class="howa-opt" data-i="${i}">${esc(o.label)}</button>`).join("");
    elPeh.innerHTML = `<div class="howa-peh-head">
        <span class="howa-peh-name">Peh</span><span class="howa-peh-where">${esc(sceneTitle(sceneId))}</span></div>
      <p class="howa-peh-say">${esc(guide.greeting)} ${esc(guide.describe)}</p>
      <p class="howa-peh-data">…reading the grounds…</p>
      <div class="howa-chips"></div><div class="howa-peh-opts">${opts}</div>`;
    elPeh.querySelectorAll(".howa-opt").forEach((b) => {
      const o = guide.options[Number(b.getAttribute("data-i"))];
      b.addEventListener("click", () => {
        if (o.go) travel(o.go);
        else if (o.ws) openWs(o.ws);
      });
    });
    // Pull live data for this scene and let Peh remark on it.
    const res = await SCENES.load(sceneId);
    if (curScene() !== sceneId) return; // moved on while loading
    const sayEl = elPeh.querySelector(".howa-peh-data");
    const chipEl = elPeh.querySelector(".howa-chips");
    if (sayEl) sayEl.textContent = PEH.remark(res.data, res.ok);
    if (chipEl && res.data && res.data.stats) {
      chipEl.innerHTML = res.data.stats.map((s) =>
        `<span class="howa-chip ${s.warn && s.value ? "warn" : ""}"><b>${esc(s.value)}</b> ${esc(s.label)}</span>`).join("");
    }
    logJournal(res.ok ? "data" : "warn",
      sceneTitle(sceneId) + " — " + PEH.remark(res.data, res.ok));
  }

  // ── Journal painting + toggle. ────────────────────────────────────────
  function paintJournal() {
    if (!elJournal) return;
    const body = elJournal.querySelector(".howa-jrn-body");
    if (!body) return;
    body.innerHTML = journal.slice().reverse().map((e) =>
      `<div class="howa-jrn-row"><time>${esc(e.t)}</time><span class="k">${esc(e.kind)}</span><span>${esc(e.text)}</span></div>`
    ).join("") || `<div style="color:var(--ink-dim)">Nothing logged yet.</div>`;
  }
  function toggleJournal(force) {
    if (!elJournal) return;
    const open = typeof force === "boolean" ? force : !elJournal.classList.contains("open");
    elJournal.classList.toggle("open", open);
  }

  // ── Command bar parser. ───────────────────────────────────────────────
  function runCommand(raw) {
    const line = String(raw || "").trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ").toLowerCase().replace(/\s+/g, "-");
    logJournal("you", line);
    if (cmd === "help" || cmd === "?") {
      logJournal("peh", "Try: go <scene> · open <workspace> · refresh · journal · status. Scenes: " +
        sceneList().map((s) => s.id).join(", "));
      return;
    }
    if (cmd === "go" || cmd === "travel" || cmd === "goto") {
      const match = sceneList().find((s) => s.id === arg || s.id.indexOf(arg) === 0 || s.title.toLowerCase().indexOf(arg) >= 0);
      if (match) { travel(match.id); }
      else logJournal("peh", "No area called \"" + arg + "\". Scenes: " + sceneList().map((s) => s.id).join(", "));
      return;
    }
    if (cmd === "open" || cmd === "ws") { openWs(arg); logJournal("peh", "Opening " + arg + "."); return; }
    if (cmd === "refresh" || cmd === "reload") { refreshStatus(); paintPeh(curScene(), visits[curScene()] || 1); logJournal("peh", "Refreshed."); return; }
    if (cmd === "journal" || cmd === "log" || cmd === "j") { toggleJournal(); return; }
    if (cmd === "status" || cmd === "health") { refreshStatus(); logJournal("peh", "Pinging the backend at " + API.base + "."); return; }
    logJournal("peh", "I didn't catch \"" + cmd + "\". Type help.");
  }

  // ── Scene watcher: detect engine navigation, drive Peh + journal. ─────
  const visits = {};
  let lastScene = null;
  function onScene(id) {
    if (!id || id === lastScene) return;
    lastScene = id;
    visits[id] = (visits[id] || 0) + 1;
    logJournal("move", "Entered " + sceneTitle(id) + ".");
    paintPeh(id, visits[id]);
  }
  function watch() {
    const here = curScene();
    if (here !== lastScene) onScene(here);
  }

  // ── Boot. ─────────────────────────────────────────────────────────────
  function start() {
    if (!API || !SCENES || !PEH || !doc) return;
    injectStyles();
    build();
    refreshStatus();
    setInterval(refreshStatus, 15000);
    onScene(curScene());           // greet wherever we land
    setInterval(watch, 400);       // follow engine-driven navigation
    global.HowaApp = { runCommand: runCommand, toggleJournal: toggleJournal, refreshStatus: refreshStatus };
  }
  if (doc && doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
  else start();
})(typeof window !== "undefined" ? window : this);

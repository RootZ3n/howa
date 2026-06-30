// ══════════════════════════════════════════════════════════════════════
// HOWA · APP GLUE — wires the live backend (api.js + scenes.js) into
// the inline world engine. Adds chrome the engine doesn't own: a backend
// status dot, a Journal drawer, a command bar, and a floating chat agent.
// All elements are appended to <body>; the engine's render() never touches
// body-direct children. Loaded AFTER the engine + api/scenes/peh-guide.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };

  // ── 1. Live workspace bodies ──────────────────────────────────────────────
  // Override pehWorkspaceBody so any defId in HowaScenes renders live HTML.
  var _origBody = window.pehWorkspaceBody;
  window.pehWorkspaceBody = function (w, deckMarkup) {
    var def = (typeof pehWorkspaceDef === 'function') ? pehWorkspaceDef(w.defId) : null;
    if (def && def.kind === 'deck') return _origBody(w, deckMarkup);
    if (window.HowaScenes && HowaScenes.has(w.defId)) {
      // Card⇄console split: a console-class panel that isn't expanded (and every
      // Voltron dashboard tile, which passes console:false) renders a COMPACT
      // glance; the full console renders when the window is expanded (w.console).
      var meta = (typeof window.pehPanelMeta === 'function') ? window.pehPanelMeta(w.defId) : {};
      var summary = !!(meta && meta.console) && !w.console;
      setTimeout(function () { HowaScenes.fill(w.defId, false, summary); }, 0);
      return HowaScenes.liveContainer(w.defId, summary);
    }
    return _origBody(w, deckMarkup);
  };

  // ── 2. Arena console — append live status strip ───────────────────────────
  var _origConsole = window.renderArenaConsole;
  if (typeof _origConsole === 'function') {
    window.renderArenaConsole = function () {
      setTimeout(function () { if (window.HowaScenes) HowaScenes.fill('console'); }, 0);
      var strip = '<div class="wks-live"><h3 class="wks-section-title">Live arena status</h3>' +
        (window.HowaScenes ? HowaScenes.liveContainer('console') : '') + '</div>';
      return _origConsole() + strip;
    };
  }

  // ── 3. Navigation logging ─────────────────────────────────────────────────
  function sceneTitle(id) {
    try { var s = pehScene(pehActiveProductId(), id); return s ? s.title : id; } catch (e) { return id; }
  }
  var _origActivate = window.pehHotspotActivate;
  if (typeof _origActivate === 'function') {
    window.pehHotspotActivate = function (sceneId, hotspotId) {
      try {
        var s = pehScene(pehActiveProductId(), sceneId);
        var h = s && s.hotspots ? s.hotspots.find(function (x) { return x.id === hotspotId; }) : null;
        if (h && h.greeting) howaLog('peh', 'Peh: "' + h.greeting + '"');
      } catch (e) {}
      return _origActivate(sceneId, hotspotId);
    };
  }
  ['pehSetScene', 'pehGoScene'].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function (sceneId) {
      try { howaLog('move', 'Moved to ' + sceneTitle(sceneId) + '.'); } catch (e) {}
      return orig.apply(this, arguments);
    };
  });

  // ── 4. Backend status dot ─────────────────────────────────────────────────
  var statusEl = null, lastOnline = null;
  function buildStatus() {
    statusEl = document.createElement('button');
    statusEl.className = 'peh-status';
    statusEl.type = 'button';
    statusEl.title = 'Arena backend status — click to recheck';
    statusEl.innerHTML = '<i class="peh-status-dot"></i><span class="peh-status-txt">checking…</span>';
    statusEl.onclick = function () { pollHealth(true); };
    document.body.appendChild(statusEl);
  }
  async function pollHealth(manual) {
    if (!statusEl) return;
    var r = await HowaAPI.health({ fresh: true });
    var dot = statusEl.querySelector('.peh-status-dot');
    var txt = statusEl.querySelector('.peh-status-txt');
    if (r.ok && r.data) {
      dot.className = 'peh-status-dot online';
      txt.textContent = 'online' + (r.data.version ? ' · v' + r.data.version : '');
      statusEl.title = 'Arena online · ' + (r.data.status || 'ok');
      if (lastOnline === false) howaLog('ok', 'Arena backend back online.');
      lastOnline = true;
    } else {
      dot.className = 'peh-status-dot offline';
      txt.textContent = 'offline';
      statusEl.title = 'Arena unreachable: ' + (r.error || 'no response');
      if (lastOnline !== false && lastOnline !== null) howaLog('warn', 'Arena backend offline. Check :18799.');
      if (manual) howaLog('warn', 'Still no response from :18799. Start the Howa server.');
      lastOnline = false;
    }
  }

  // ── 5. Command bar ────────────────────────────────────────────────────────
  var COMMANDS = 'help, health, goto <scene>, ask <message>, journal';
  function buildCommandBar() {
    var bar = document.createElement('form');
    bar.className = 'peh-cmd';
    bar.innerHTML =
      '<span class="peh-cmd-mark" aria-hidden="true">⚔</span>' +
      '<input class="peh-cmd-input" type="text" autocomplete="off" spellcheck="false" ' +
        'placeholder="Command the Arena — try: help">' +
      '<button class="peh-cmd-go" type="submit" aria-label="Run">Run</button>';
    document.body.appendChild(bar);
    var input = bar.querySelector('.peh-cmd-input');
    bar.onsubmit = function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) return;
      input.value = '';
      runCommand(v);
    };
  }

  var SCENE_ALIASES = {
    gate: 'main-gate', entrance: 'main-gate', 'main-gate': 'main-gate',
    arena: 'arena',
    training: 'training-grounds', grounds: 'training-grounds', 'training-grounds': 'training-grounds',
    temple: 'temple',
    armory: 'armory',
    market: 'market',
  };

  async function runCommand(raw) {
    var parts = raw.split(/\s+/);
    var cmd = parts.shift().toLowerCase();
    var rest = parts.join(' ');
    howaLog('you', raw);
    switch (cmd) {
      case 'help': case '?':
        howaLog('peh', 'Commands: ' + COMMANDS);
        break;
      case 'health':
        var hr = await HowaAPI.apiHealth({ fresh: true });
        if (hr.ok && hr.data) {
          howaLog('data', 'Health: ' + (hr.data.status || '?') + (hr.data.version ? ' · v' + hr.data.version : ''));
        } else {
          howaLog('warn', 'Health: offline (' + (hr.error || '?') + ')');
        }
        break;
      case 'goto': case 'go':
        var target = SCENE_ALIASES[rest.toLowerCase()] || rest;
        if (target && typeof pehGoScene === 'function') {
          try { pehGoScene(target); } catch (e) { howaLog('warn', 'Unknown area: "' + rest + '". Try: gate, arena, training, temple, armory, market'); }
        }
        break;
      case 'journal': case 'j': case 'log':
        toggleJournal();
        break;
      case 'ask':
        if (!rest) { howaLog('peh', 'Ask what? e.g. "ask how many agents are registered?"'); break; }
        await ask(rest);
        break;
      default:
        await ask(raw);
    }
  }

  async function ask(message) {
    howaLog('note', 'Peh: processing…');
    var r = await HowaAPI.converse(message);
    if (r.ok && r.data && (r.data.response || r.data.content)) {
      howaLog('peh', 'Peh: ' + (r.data.response || r.data.content));
    } else if (r.status === 503) {
      howaLog('warn', 'Chat unavailable — configure HOWA_CHAT_TOKEN on the server.');
    } else {
      howaLog('warn', 'No response from the Arena. Is it running on :18799?');
    }
  }

  window.HowaApp = { runCommand: runCommand, ask: ask, pollHealth: pollHealth };

  // ── 6. Journal (build log drawer) ────────────────────────────────────────
  var journal = [], JOURNAL_MAX = 80;
  var elJrnlList, elJrnlBadge, elJrnlDrawer;
  var journalOpen = false;

  function clock() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function howaLog(kind, text) {
    journal.push({ t: clock(), kind: kind, text: text });
    if (journal.length > JOURNAL_MAX) journal.splice(0, journal.length - JOURNAL_MAX);
    paintJournal();
    if (elJrnlBadge) {
      var n = journal.length;
      elJrnlBadge.textContent = n > 9 ? '9+' : String(n);
      elJrnlBadge.classList.add('pulse');
      setTimeout(function () { if (elJrnlBadge) elJrnlBadge.classList.remove('pulse'); }, 600);
    }
  }
  function paintJournal() {
    if (!elJrnlList) return;
    if (!journal.length) { elJrnlList.innerHTML = '<li class="peh-jrnl-empty">Nothing logged yet.</li>'; return; }
    elJrnlList.innerHTML = journal.slice().reverse().map(function (e) {
      return '<li class="peh-jrnl-item k-' + esc(e.kind) + '">' +
        '<time class="peh-jrnl-time">' + esc(e.t) + '</time>' +
        '<span class="peh-jrnl-text">' + esc(e.text) + '</span>' +
      '</li>';
    }).join('');
  }
  function toggleJournal(open) {
    if (!elJrnlDrawer) return;
    journalOpen = typeof open === 'boolean' ? open : !journalOpen;
    elJrnlDrawer.classList.toggle('open', journalOpen);
  }
  function buildJournal() {
    var btn = document.createElement('button');
    btn.className = 'peh-jrnl-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle session journal');
    btn.innerHTML = '<span class="peh-jrnl-ico">📜</span><span>Journal</span><span class="peh-jrnl-badge" id="howa-jrnl-badge">0</span>';
    btn.onclick = function () { toggleJournal(); };
    document.body.appendChild(btn);
    elJrnlBadge = btn.querySelector('#howa-jrnl-badge');

    elJrnlDrawer = document.createElement('aside');
    elJrnlDrawer.className = 'peh-jrnl-drawer';
    elJrnlDrawer.setAttribute('role', 'log');
    elJrnlDrawer.setAttribute('aria-label', "Peh's Journal");
    elJrnlDrawer.innerHTML =
      '<div class="peh-jrnl-head">' +
        '<b>Peh\'s Journal</b>' +
        '<span>session log</span>' +
        '<button class="peh-jrnl-close" type="button" aria-label="Close journal">×</button>' +
      '</div>' +
      '<ul class="peh-jrnl-list"></ul>';
    document.body.appendChild(elJrnlDrawer);
    elJrnlList = elJrnlDrawer.querySelector('.peh-jrnl-list');
    elJrnlDrawer.querySelector('.peh-jrnl-close').onclick = function () { toggleJournal(false); };
  }

  // expose for command bar
  window.HowaApp.howaLog = function () { howaLog.apply(null, arguments); };
  window.HowaApp.toggleJournal = function () { toggleJournal(); };

  // ── 7. Floating chat agent ────────────────────────────────────────────────
  var chatOpen = false, chatDrawerEl, chatBtnEl;
  function buildChat() {
    chatBtnEl = document.createElement('button');
    chatBtnEl.className = 'howa-chat-btn';
    chatBtnEl.type = 'button';
    chatBtnEl.title = 'Chat with Peh';
    chatBtnEl.setAttribute('aria-label', 'Open Peh chat');
    chatBtnEl.innerHTML = '⚔';
    chatBtnEl.onclick = toggleHowaChat;
    document.body.appendChild(chatBtnEl);

    chatDrawerEl = document.createElement('div');
    chatDrawerEl.className = 'howa-chat-drawer';
    chatDrawerEl.setAttribute('role', 'dialog');
    chatDrawerEl.setAttribute('aria-label', 'Peh — Arena Guide');
    chatDrawerEl.innerHTML =
      '<div class="howa-chat-header">' +
        '<div class="howa-chat-avatar"><img src="assets/peh-howa.png" alt="" aria-hidden="true" onerror="this.style.display=\'none\'"></div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:700;font-size:13px;color:#f0ece4">Peh</div>' +
          '<div style="font-size:11px;color:var(--ink-dim)">Arena Guide</div>' +
        '</div>' +
        '<button class="howa-chat-close" type="button" aria-label="Close chat">×</button>' +
      '</div>' +
      '<div class="howa-chat-messages" id="howa-chat-msgs"></div>' +
      '<div class="howa-chat-input-wrap">' +
        '<input class="howa-chat-input" type="text" id="howa-chat-input" ' +
          'placeholder="Ask the Arena…" autocomplete="off" spellcheck="false">' +
        '<button class="howa-chat-send" type="button">Send</button>' +
      '</div>';
    document.body.appendChild(chatDrawerEl);

    chatDrawerEl.querySelector('.howa-chat-close').onclick = toggleHowaChat;
    chatDrawerEl.querySelector('.howa-chat-send').onclick = sendHowaChat;
    chatDrawerEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'howa-chat-input') {
        e.preventDefault();
        sendHowaChat();
      }
    });

    appendChatMsg('assistant', 'The gate is open. I\'m Peh — your guide through the Arena. What do you want to know about the trials?');
  }

  function toggleHowaChat() {
    chatOpen = !chatOpen;
    if (chatDrawerEl) chatDrawerEl.classList.toggle('open', chatOpen);
    if (chatBtnEl) chatBtnEl.classList.toggle('active', chatOpen);
    if (chatOpen) {
      var inp = document.getElementById('howa-chat-input');
      if (inp) setTimeout(function () { try { inp.focus(); } catch (e) {} }, 60);
    }
  }
  function appendChatMsg(role, text) {
    var msgs = document.getElementById('howa-chat-msgs');
    if (!msgs) return;
    var el = document.createElement('div');
    el.className = 'howa-msg ' + role;
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }
  async function sendHowaChat() {
    var inp = document.getElementById('howa-chat-input');
    if (!inp) return;
    var text = (inp.value || '').trim();
    if (!text) return;
    inp.value = '';
    appendChatMsg('user', text);

    var msgs = document.getElementById('howa-chat-msgs');
    var thinking = document.createElement('div');
    thinking.className = 'howa-msg assistant';
    thinking.style.cssText = 'opacity:.5;font-style:italic';
    thinking.textContent = 'Processing…';
    if (msgs) { msgs.appendChild(thinking); msgs.scrollTop = msgs.scrollHeight; }

    var r = await HowaAPI.converse(text);
    if (thinking.parentNode) thinking.parentNode.removeChild(thinking);

    if (r.ok && r.data && (r.data.response || r.data.content)) {
      appendChatMsg('assistant', r.data.response || r.data.content);
    } else if (r.status === 503) {
      appendChatMsg('error', 'Chat requires HOWA_CHAT_TOKEN to be set on the server.');
    } else if (r.status === 401) {
      appendChatMsg('error', 'Unauthorized. Set HOWA_CHAT_TOKEN on the server.');
    } else {
      appendChatMsg('error', 'No response from the Arena. Is it running on :18799?');
    }
  }

  window.toggleHowaChat = toggleHowaChat;
  window.sendHowaChat = sendHowaChat;

  // ── Boot ──────────────────────────────────────────────────────────────────
  function start() {
    buildJournal();
    buildStatus();
    buildCommandBar();
    buildChat();
    howaLog('peh', 'The gate is open. Past this point, there are no shortcuts.');
    if (typeof window.render === 'function') { try { window.render(); } catch (e) {} }
    pollHealth();
    setInterval(function () { pollHealth(); }, 12000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

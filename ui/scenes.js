// ══════════════════════════════════════════════════════════════════════
// HOWA · SCENES — per-workspace live HTML renderers
// Mirrors the ikbi IkbiScenes pattern. Three surface methods:
//   has(defId)           — true if we know this workspace
//   liveContainer(defId) — placeholder HTML injected while data loads
//   fill(defId)          — async: fetches live data, replaces container
// Workspace ids must match WORKSPACE_REGISTRY in index.html.
// ══════════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';
  var API = global.HowaAPI;
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };

  function arr(v) { return Array.isArray(v) ? v : []; }
  function shortId(id) { return String(id || '').slice(-10); }
  function fmtDate(ms) {
    if (!ms) return '—';
    try {
      var d = new Date(ms);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return String(ms); }
  }
  function fmtDur(ms) {
    if (!ms) return '—';
    return ms < 2000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
  }

  function stat(label, value, warn) {
    return '<div class="peh-stat' + (warn ? ' warn' : '') + '"><span class="peh-stat-v">' + esc(value) + '</span><span class="peh-stat-l">' + esc(label) + '</span></div>';
  }
  function verdictCls(v) { return ({ pass: 'pass', fail: 'fail', error: 'error' })[v] || 'unknown'; }
  function verdictBadge(v) { return '<span class="howa-verdict ' + verdictCls(v) + '">' + esc(v || '?') + '</span>'; }
  function loading() { return '<div class="peh-live-loading"><span class="peh-live-spin"></span> Loading…</div>'; }
  function offline(err) {
    return '<div class="peh-live-off"><b>Arena offline</b><span class="peh-live-off-hint">' + esc(err || 'Backend not reachable') + '</span></div>';
  }

  function cid(defId) { return 'howa-live-' + defId.replace(/[^a-z0-9]/g, '-'); }

  // ── console (deck kind) — live health strip appended by app.js ──────────
  async function fillConsole(el) {
    var r = await API.apiHealth({ fresh: true });
    if (!r.ok) { el.innerHTML = offline(r.error); return; }
    var d = r.data || {};
    el.innerHTML =
      '<div class="peh-stats">' +
        stat('Status', d.status || 'ok') +
        stat('Version', d.version || '—') +
        (d.stateRoot ? stat('State root', shortId(d.stateRoot) + '…') : '') +
      '</div>';
  }

  // ── arena-status — full health detail ───────────────────────────────────
  async function fillArenaStatus(el) {
    var r1 = API.health({ fresh: true });
    var r2 = API.apiHealth({ fresh: true });
    var h = await r1, ah = await r2;
    var hd = h.data || {}, ahd = ah.data || {};
    el.innerHTML =
      '<div class="howa-ws">' +
        '<div class="howa-ws-section">' +
          '<h3 class="howa-ws-head">Backend health</h3>' +
          '<div class="peh-stats">' +
            stat('Service health', h.ok ? 'online' : 'offline') +
            stat('API health', ah.ok ? 'online' : 'offline') +
            stat('Version', ahd.version || hd.version || '—') +
            stat('Status', ahd.status || hd.status || '—') +
          '</div>' +
        '</div>' +
        (!h.ok && !ah.ok ? offline(h.error || ah.error) : '') +
        (ahd.stateRoot ?
          '<div class="howa-ws-section">' +
            '<h3 class="howa-ws-head">State</h3>' +
            '<div class="peh-rows"><div class="peh-row">' +
              '<span class="peh-row-t">' + esc(ahd.stateRoot) + '</span>' +
              '<span class="peh-row-m">state root</span>' +
            '</div></div>' +
          '</div>'
        : '') +
      '</div>';
  }

  // ── trial-config — registered packs + agents ─────────────────────────────
  async function fillTrialConfig(el) {
    var pr = API.packs({ fresh: true });
    var ar = API.agents({ fresh: true });
    var packR = await pr, agentR = await ar;
    var packs = arr(packR.data && packR.data.packs);
    var agents = arr(agentR.data && agentR.data.agents);
    el.innerHTML =
      '<div class="howa-ws">' +
        '<div class="howa-ws-section">' +
          '<h3 class="howa-ws-head">Packs (' + packs.length + ')</h3>' +
          (packs.length ?
            '<div class="howa-pack-list">' + packs.map(function (p) {
              return '<span class="howa-pack">' + esc(p.id || p.name || String(p)) + '</span>';
            }).join('') + '</div>'
          : '<p class="peh-live-empty">No packs registered.</p>') +
        '</div>' +
        '<div class="howa-ws-section">' +
          '<h3 class="howa-ws-head">Agents (' + agents.length + ')</h3>' +
          (agents.length ?
            '<div class="howa-agent-list">' + agents.map(function (a) {
              return '<div class="howa-agent-row">' +
                '<span class="howa-agent-id">' + esc(a.id || a.agentId || '?') + '</span>' +
                '<span class="howa-agent-adapter">' + esc(a.adapter || a.type || a.model || '') + '</span>' +
              '</div>';
            }).join('') + '</div>'
          : '<p class="peh-live-empty">No agents registered.</p>') +
        '</div>' +
      '</div>';
  }

  // ── results — trial results: verdicts, scores, pass rates ───────────────
  async function fillResults(el) {
    var r = await API.trials({ fresh: true });
    if (!r.ok) { el.innerHTML = offline(r.error); return; }
    var trials = arr(r.data && r.data.trials).sort(function (a, b) { return (b.finishedAt || 0) - (a.finishedAt || 0); });
    var passed = trials.filter(function (t) { return t.verdict === 'pass'; }).length;
    var failed = trials.filter(function (t) { return t.verdict === 'fail'; }).length;
    var errored = trials.filter(function (t) { return t.verdict === 'error'; }).length;
    el.innerHTML =
      '<div class="howa-ws">' +
        '<div class="howa-ws-section">' +
          '<div class="peh-stats">' +
            stat('Total', trials.length) +
            stat('Passed', passed) +
            stat('Failed', failed, failed > 0) +
            stat('Errors', errored, errored > 0) +
          '</div>' +
        '</div>' +
        (trials.length ?
          '<div class="howa-ws-section">' +
            '<h3 class="howa-ws-head">Recent trials</h3>' +
            '<div class="howa-trial-list">' + trials.slice(0, 30).map(function (t) {
              var passRate = t.testCount ? ((t.passCount || 0) + '/' + t.testCount) : '—';
              return '<div class="howa-trial-row">' +
                '<span class="howa-trial-id">' + esc(shortId(t.trialId || t.id || '?')) + '</span>' +
                verdictBadge(t.verdict) +
                '<span class="howa-trial-label">' + esc(t.agentId || t.adapter || 'agent') + '</span>' +
                '<span class="howa-trial-sub">' + esc(passRate) + '</span>' +
              '</div>';
            }).join('') + '</div>' +
          '</div>'
        : '<p class="peh-live-empty">No trials recorded yet.</p>') +
      '</div>';
  }

  // ── receipts — execution receipts for completed trials ──────────────────
  async function fillReceipts(el) {
    var tr = await API.trials({ fresh: true });
    if (!tr.ok) { el.innerHTML = offline(tr.error); return; }
    var trials = arr(tr.data && tr.data.trials)
      .sort(function (a, b) { return (b.finishedAt || 0) - (a.finishedAt || 0); })
      .slice(0, 5);
    if (!trials.length) {
      el.innerHTML = '<div class="howa-ws"><p class="peh-live-empty">No trials with receipts yet.</p></div>';
      return;
    }
    var results = await Promise.all(trials.map(function (t) {
      return API.receipts(t.trialId || t.id || '', { fresh: true });
    }));
    el.innerHTML = '<div class="howa-ws">' + trials.map(function (t, i) {
      var rr = results[i];
      var receipts = arr(rr.data && rr.data.receipts);
      return '<div class="howa-ws-section">' +
        '<h3 class="howa-ws-head">' + esc(shortId(t.trialId || t.id || '?')) + ' ' + verdictBadge(t.verdict) + '</h3>' +
        (receipts.length ?
          '<div class="howa-receipt-list">' + receipts.slice(0, 6).map(function (rc) {
            var cls = rc.passed === true ? 'k-pass' : rc.passed === false ? 'k-fail' : '';
            return '<div class="howa-receipt-row ' + cls + '">' +
              '<span class="howa-receipt-time">' + esc(rc.testId || rc.id || '') + '</span>' +
              '<span class="howa-receipt-text">' + esc(rc.message || rc.description || rc.outcome || '—') + '</span>' +
            '</div>';
          }).join('') + '</div>'
        : '<p class="peh-live-empty">No receipt data for this trial.</p>') +
      '</div>';
    }).join('') + '</div>';
  }

  // ── agents-ws — registered agents and their configurations ──────────────
  async function fillAgents(el) {
    var r = await API.agents({ fresh: true });
    if (!r.ok) { el.innerHTML = offline(r.error); return; }
    var agents = arr(r.data && r.data.agents);
    el.innerHTML =
      '<div class="howa-ws">' +
        '<div class="howa-ws-section">' +
          '<div class="peh-stats">' + stat('Registered agents', agents.length) + '</div>' +
        '</div>' +
        (agents.length ?
          '<div class="howa-ws-section">' +
            '<h3 class="howa-ws-head">Agent roster</h3>' +
            '<div class="howa-agent-list">' + agents.map(function (a) {
              return '<div class="howa-agent-row">' +
                '<span class="howa-agent-id">' + esc(a.id || a.agentId || '?') + '</span>' +
                '<span class="howa-agent-adapter">' + esc(a.adapter || a.type || a.model || '') + '</span>' +
              '</div>';
            }).join('') + '</div>' +
          '</div>'
        : '<p class="peh-live-empty">No agents registered yet.</p>') +
      '</div>';
  }

  // ── history-ws — full trial history, timeline and audit trail ───────────
  async function fillHistory(el) {
    var r = await API.trials({ fresh: true });
    if (!r.ok) { el.innerHTML = offline(r.error); return; }
    var trials = arr(r.data && r.data.trials).sort(function (a, b) {
      return (b.startedAt || b.createdAt || b.finishedAt || 0) - (a.startedAt || a.createdAt || a.finishedAt || 0);
    });
    el.innerHTML =
      '<div class="howa-ws">' +
        '<div class="howa-ws-section">' +
          '<div class="peh-stats">' + stat('Total trials', trials.length) + '</div>' +
        '</div>' +
        (trials.length ?
          '<div class="howa-ws-section">' +
            '<h3 class="howa-ws-head">Timeline</h3>' +
            '<div class="howa-trial-list">' + trials.map(function (t) {
              var ts = t.startedAt || t.createdAt || t.finishedAt;
              return '<div class="howa-trial-row">' +
                verdictBadge(t.verdict) +
                '<span class="howa-trial-label">' + esc(t.agentId || t.adapter || 'agent') + '</span>' +
                '<span class="howa-trial-sub">' + esc(fmtDate(ts)) + '</span>' +
                '<span class="howa-trial-sub">' + esc(fmtDur(t.durationMs)) + '</span>' +
              '</div>';
            }).join('') + '</div>' +
          '</div>'
        : '<p class="peh-live-empty">No history yet.</p>') +
      '</div>';
  }

  var FILLERS = {
    'console':      fillConsole,
    'arena-status': fillArenaStatus,
    'trial-config': fillTrialConfig,
    'results':      fillResults,
    'receipts':     fillReceipts,
    'agents-ws':    fillAgents,
    'history-ws':   fillHistory,
  };

  global.HowaScenes = {
    has: function (defId) { return !!FILLERS[defId]; },
    liveContainer: function (defId) {
      return '<div id="' + cid(defId) + '" class="peh-live">' + loading() + '</div>';
    },
    fill: async function (defId) {
      var el = document.getElementById(cid(defId));
      if (!el) return;
      var fn = FILLERS[defId];
      if (!fn) { el.innerHTML = '<p class="peh-live-empty">No renderer for this workspace.</p>'; return; }
      try { await fn(el); } catch (e) { el.innerHTML = offline(e && e.message ? e.message : String(e)); }
    },
  };
})(typeof window !== 'undefined' ? window : this);

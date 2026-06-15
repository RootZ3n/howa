// ══════════════════════════════════════════════════════════════════════
// HOWA · API CLIENT
// Thin fetch wrapper over the Arena backend (same-origin, port 18799).
// All calls resolve to { ok, data, error, status } and NEVER throw.
// Simple TTL cache for GETs; pass { fresh:true } to bypass.
// ══════════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  function resolveBase() {
    try {
      if (global.HOWA_API_BASE) return String(global.HOWA_API_BASE).replace(/\/$/, '');
      var loc = global.location;
      if (loc && loc.protocol && loc.protocol.indexOf('http') === 0) return loc.origin;
    } catch (e) {}
    return 'http://127.0.0.1:18799';
  }

  var BASE = resolveBase();
  var cache = {};
  var TTL = 8000;

  async function get(path, opts) {
    opts = opts || {};
    var key = path;
    if (!opts.fresh && cache[key] && (Date.now() - cache[key].ts < (opts.ttl != null ? opts.ttl : TTL))) {
      return cache[key].result;
    }
    var controller, timer;
    try {
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timer = setTimeout(function () { try { controller.abort(); } catch (e) {} }, 8000);
      }
      var res = await fetch(BASE + path, { headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined });
      if (timer) clearTimeout(timer);
      var text = await res.text();
      var data = null;
      try { if (text) data = JSON.parse(text); } catch (e) { data = { raw: text }; }
      var result = { ok: res.ok, status: res.status, data: data, error: res.ok ? null : ((data && (data.error || data.message)) || ('HTTP ' + res.status)) };
      if (res.ok) cache[key] = { result: result, ts: Date.now() };
      return result;
    } catch (e) {
      if (timer) clearTimeout(timer);
      return { ok: false, status: 0, data: null, error: e && e.name === 'AbortError' ? 'request timed out' : 'network error — ' + (e ? e.message : String(e)) };
    }
  }

  async function post(path, body) {
    try {
      var res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body || {})
      });
      var text = await res.text();
      var data = null;
      try { if (text) data = JSON.parse(text); } catch (e) { data = { raw: text }; }
      return { ok: res.ok, status: res.status, data: data, error: res.ok ? null : ((data && (data.error || data.message)) || ('HTTP ' + res.status)) };
    } catch (e) {
      return { ok: false, status: 0, data: null, error: 'network error — ' + (e ? e.message : String(e)) };
    }
  }

  global.HowaAPI = {
    base:      BASE,
    health:    function (o) { return get('/health', o); },
    apiHealth: function (o) { return get('/api/health', o); },
    agents:    function (o) { return get('/api/agents', o); },
    packs:     function (o) { return get('/api/packs', o); },
    trials:    function (o) { return get('/api/trials', o); },
    trial:     function (id, o) { return id ? get('/api/trials/' + encodeURIComponent(id), o) : Promise.resolve({ ok: false, data: null, error: 'id required', status: 0 }); },
    receipts:  function (trialId, o) { return trialId ? get('/api/receipts/' + encodeURIComponent(trialId), o) : Promise.resolve({ ok: false, data: null, error: 'trial id required', status: 0 }); },
    logs:      function (limit, o) { var q = Number.isFinite(+limit) && +limit > 0 ? '?limit=' + Math.min(+limit, 1000) : ''; return get('/api/admin/logs' + q, o); },
    converse:  function (message) { return post('/chat', { message: message }); },
  };
})(typeof window !== 'undefined' ? window : this);

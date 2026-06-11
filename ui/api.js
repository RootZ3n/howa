// ══════════════════════════════════════════════════════════════════════
// HOWA · api.js — backend client for the Arena UI (port 18799)
// Every call returns {ok, data, error} and NEVER throws. The UI can treat
// a dead backend exactly like an empty one: ok=false, data=null, error set.
// Pure vanilla. No deps. Mirrors the read-only GET surface of src/api.
// ══════════════════════════════════════════════════════════════════════
(function (global) {
  "use strict";

  // Same-origin when the UI is served by the Howa server. When opened from
  // disk (file://) fall back to the documented local port so a dev can still
  // point the page at a running backend.
  function resolveBase() {
    try {
      if (global.HOWA_API_BASE) return String(global.HOWA_API_BASE).replace(/\/$/, "");
      const loc = global.location;
      if (loc && loc.protocol && loc.protocol.indexOf("http") === 0) {
        return loc.origin;
      }
    } catch (e) { /* ignore */ }
    return "http://127.0.0.1:18799";
  }

  const BASE = resolveBase();
  const DEFAULT_TIMEOUT_MS = 8000;

  // Core fetch wrapper. Resolves (never rejects) to {ok, data, error, status}.
  async function request(path, opts) {
    const url = BASE + path;
    const o = opts || {};
    let controller = null;
    let timer = null;
    try {
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        timer = setTimeout(() => { try { controller.abort(); } catch (e) {} },
          o.timeout || DEFAULT_TIMEOUT_MS);
      }
      const res = await fetch(url, {
        method: o.method || "GET",
        headers: { Accept: "application/json" },
        signal: controller ? controller.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      const status = res.status;
      let body = null;
      const text = await res.text();
      if (text) { try { body = JSON.parse(text); } catch (e) { body = { raw: text }; } }
      if (!res.ok) {
        const msg = (body && (body.error || body.message)) || ("HTTP " + status);
        return { ok: false, data: body, error: String(msg), status: status };
      }
      return { ok: true, data: body, error: null, status: status };
    } catch (err) {
      if (timer) clearTimeout(timer);
      const aborted = err && (err.name === "AbortError");
      return {
        ok: false,
        data: null,
        error: aborted ? "request timed out" : ("network error — " + (err && err.message ? err.message : String(err))),
        status: 0,
      };
    }
  }

  const HowaAPI = {
    base: BASE,
    request: request,

    // GET /api/health → {ok, stateRoot, version}
    health: function () { return request("/api/health"); },

    // GET /api/agents → {agents:[...]}
    agents: function () { return request("/api/agents"); },

    // GET /api/packs → {packs:[...]}
    packs: function () { return request("/api/packs"); },

    // GET /api/trials → {trials:[...]}  (each entry is a TrialSummary)
    trials: function () { return request("/api/trials"); },

    // GET /api/trials/:id → TrialSummary
    trial: function (id) {
      if (!id) return Promise.resolve({ ok: false, data: null, error: "trial id required" });
      return request("/api/trials/" + encodeURIComponent(id));
    },

    // GET /api/receipts/:trialId → {receipts:[...]}
    receipts: function (trialId) {
      if (!trialId) return Promise.resolve({ ok: false, data: null, error: "trial id required" });
      return request("/api/receipts/" + encodeURIComponent(trialId));
    },

    // GET /api/admin/logs?limit=N → {entries:[...]}
    logs: function (limit) {
      const n = Number(limit);
      const q = Number.isFinite(n) && n > 0 ? "?limit=" + Math.min(n, 1000) : "";
      return request("/api/admin/logs" + q);
    },

    // GET /api/admin/cleanup → dry-run reaper report (read-only).
    cleanupPlan: function () { return request("/api/admin/cleanup"); },
  };

  global.HowaAPI = HowaAPI;
})(typeof window !== "undefined" ? window : this);

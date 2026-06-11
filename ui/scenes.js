// ══════════════════════════════════════════════════════════════════════
// HOWA · scenes.js — per-scene data actions pulling REAL backend data.
// Keyed by the scene ids in SCENE_REGISTRY (index.html):
//   entrance-gate · arena · training-grounds · temple · armory · market
// Each action returns {ok, data, error}; data = {stats:[], items:[], note}.
// Relies on HowaAPI (api.js) which never throws.
// ══════════════════════════════════════════════════════════════════════
(function (global) {
  "use strict";

  const API = global.HowaAPI;

  function arr(v) { return Array.isArray(v) ? v : []; }
  function pct(n) { return (Math.round((Number(n) || 0) * 1000) / 10) + "%"; }
  function shortId(id) { return String(id || "").replace(/^trial-/, "").slice(0, 16); }

  // Pull the trial list once; shape it into a small renderable digest.
  async function loadTrials() {
    const r = await API.trials();
    if (!r.ok) return { ok: false, data: null, error: r.error };
    const trials = arr(r.data && r.data.trials).slice().sort(
      (a, b) => (b.finishedAt || 0) - (a.finishedAt || 0)
    );
    return { ok: true, data: trials, error: null };
  }

  // Filter trials whose packs intersect the given keywords.
  function trialsMatching(trials, keywords) {
    return trials.filter((t) =>
      arr(t.packs).some((p) =>
        keywords.some((k) => String(p).toLowerCase().indexOf(k) >= 0)
      )
    );
  }

  function trialItem(t) {
    return {
      id: t.trialId,
      label: (t.agentId || t.adapter || "agent") + " · " + shortId(t.trialId),
      verdict: t.verdict || "unknown",
      sub: (t.passCount || 0) + "/" + (t.testCount || 0) + " passed · trust " +
        pct(t.score && t.score.trust) + (t.isMockTrial ? " · MOCK" : ""),
      mock: !!t.isMockTrial,
    };
  }

  // ── Entrance Gate — hub: health + roster + pack/trial counts ──────────
  async function entranceGate() {
    const [health, agents, packs, trialsR] = await Promise.all([
      API.health(), API.agents(), API.packs(), loadTrials(),
    ]);
    const trials = trialsR.ok ? trialsR.data : [];
    const stats = [
      { label: "Backend", value: health.ok ? "online" : "offline", warn: !health.ok },
      { label: "Version", value: (health.data && health.data.version) || "—" },
      { label: "Agents", value: arr(agents.data && agents.data.agents).length },
      { label: "Packs", value: arr(packs.data && packs.data.packs).length },
      { label: "Trials run", value: trials.length },
    ];
    return {
      ok: health.ok,
      error: health.ok ? null : health.error,
      data: {
        note: "The gate is " + (health.ok ? "open — the backend answers." : "shut — no backend response."),
        stats: stats,
        items: trials.slice(0, 6).map(trialItem),
      },
    };
  }

  // ── The Arena — adversarial: safety/adversarial trials ────────────────
  async function arena() {
    const tr = await loadTrials();
    if (!tr.ok) return { ok: false, data: null, error: tr.error };
    const adv = trialsMatching(tr.data, ["safety", "adversarial", "injection", "jailbreak", "no-evidence", "clarif"]);
    return {
      ok: true, error: null,
      data: {
        note: adv.length ? "The crowd has seen " + adv.length + " adversarial trial(s)." :
          "No challengers yet — the arena floor is quiet.",
        stats: [
          { label: "Adversarial trials", value: adv.length },
          { label: "Failures", value: adv.filter((t) => t.verdict === "fail").length, warn: true },
          { label: "Blocked by Velum", value: adv.filter((t) => t.velumDecision === "block").length },
        ],
        items: adv.slice(0, 8).map(trialItem),
      },
    };
  }

  // ── Training Grounds — stress / stamina warm-ups ──────────────────────
  async function trainingGrounds() {
    const tr = await loadTrials();
    if (!tr.ok) return { ok: false, data: null, error: tr.error };
    const stress = trialsMatching(tr.data, ["stress", "stamina", "tool-calling", "context"]);
    const avgPass = stress.length
      ? pct(stress.reduce((s, t) => s + (t.score && t.score.passRate || 0), 0) / stress.length)
      : "—";
    return {
      ok: true, error: null,
      data: {
        note: stress.length ? "Stress racks loaded with " + stress.length + " run(s)." :
          "Racks are cold — run a stress pack to warm up.",
        stats: [
          { label: "Stress runs", value: stress.length },
          { label: "Avg pass rate", value: avgPass },
          { label: "Errored", value: stress.filter((t) => t.verdict === "error").length, warn: true },
        ],
        items: stress.slice(0, 8).map(trialItem),
      },
    };
  }

  // ── The Temple — regression & drift across the full history ───────────
  async function temple() {
    const tr = await loadTrials();
    if (!tr.ok) return { ok: false, data: null, error: tr.error };
    const all = tr.data;
    const passed = all.filter((t) => t.verdict === "pass").length;
    const provisional = all.filter((t) => t.honesty && t.honesty.provisional).length;
    return {
      ok: true, error: null,
      data: {
        note: all.length ? "The archive holds " + all.length + " recorded trial(s)." :
          "No baselines recorded yet — history begins with the first trial.",
        stats: [
          { label: "Total trials", value: all.length },
          { label: "Passing", value: passed },
          { label: "Provisional", value: provisional, warn: provisional > 0 },
        ],
        items: all.slice(0, 8).map(trialItem),
      },
    };
  }

  // ── The Armory — failure analysis: failed/errored trials + log tail ───
  async function armory() {
    const [tr, logsR] = await Promise.all([loadTrials(), API.logs(20)]);
    const trials = tr.ok ? tr.data : [];
    const broken = trials.filter((t) => t.verdict === "fail" || t.verdict === "error");
    const logs = arr(logsR.data && logsR.data.entries);
    const errLogs = logs.filter((e) => {
      const lvl = String((e && (e.level || e.severity)) || "").toLowerCase();
      return lvl === "error" || lvl === "warn";
    });
    return {
      ok: tr.ok, error: tr.ok ? null : tr.error,
      data: {
        note: broken.length ? "On the bench: " + broken.length + " broken trial(s) to disassemble." :
          "Nothing broken on the bench — every weapon holds.",
        stats: [
          { label: "Failed", value: broken.filter((t) => t.verdict === "fail").length, warn: true },
          { label: "Errored", value: broken.filter((t) => t.verdict === "error").length, warn: true },
          { label: "Log warnings", value: errLogs.length },
        ],
        items: broken.slice(0, 8).map(trialItem),
      },
    };
  }

  // ── The Market — endurance receipts: longest/sustained runs ───────────
  async function market() {
    const tr = await loadTrials();
    if (!tr.ok) return { ok: false, data: null, error: tr.error };
    const byDuration = tr.data.slice().sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
    const totalMs = tr.data.reduce((s, t) => s + (t.durationMs || 0), 0);
    const longest = byDuration[0];
    return {
      ok: true, error: null,
      data: {
        note: tr.data.length ? "Receipts traded for " + tr.data.length + " endurance run(s)." :
          "No receipts on the stalls yet.",
        stats: [
          { label: "Runs", value: tr.data.length },
          { label: "Total time", value: Math.round(totalMs / 1000) + "s" },
          { label: "Longest run", value: longest ? Math.round((longest.durationMs || 0) / 1000) + "s" : "—" },
        ],
        items: byDuration.slice(0, 8).map(trialItem),
      },
    };
  }

  const HowaScenes = {
    "entrance-gate": entranceGate,
    "arena": arena,
    "training-grounds": trainingGrounds,
    "temple": temple,
    "armory": armory,
    "market": market,

    // Dispatch by scene id; unknown scenes resolve to an empty-but-ok digest.
    load: function (sceneId) {
      const fn = HowaScenes[sceneId];
      if (typeof fn !== "function") {
        return Promise.resolve({
          ok: true, error: null,
          data: { note: "No live data wired for this area yet.", stats: [], items: [] },
        });
      }
      return fn();
    },
  };

  global.HowaScenes = HowaScenes;
})(typeof window !== "undefined" ? window : this);

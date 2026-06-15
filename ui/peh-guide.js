// ══════════════════════════════════════════════════════════════════════
// HOWA · peh-guide.js — Peh, your world guide. He is MALE (he/him).
// Peh greets you at each scene, tells you where you are, and offers the
// moves that make sense here. Voice: a steady arena-master — plain, a
// little proud, never flowery. Scene ids match SCENE_REGISTRY.
// Workspace ids match WORKSPACE_REGISTRY in index.html.
// ══════════════════════════════════════════════════════════════════════
(function (global) {
  'use strict';

  // Each entry: greeting (first words on arrival), describe (what this place
  // is), and options (the moves Peh offers). An option's `go` is a scene id
  // to travel to; `ws` opens a workspace; both may be present.
  var GUIDE = {
    'main-gate': {
      greeting: 'Welcome to the Arena. Past this gate, there are no shortcuts — only trials.',
      describe: 'This is the gate. Every model is tested here until it breaks or it doesn\'t. Pick where we go, or tap a place on the map and I\'ll meet you there.',
      options: [
        { label: 'Take me to the Arena', go: 'arena' },
        { label: 'Show the Training Grounds', go: 'training-grounds' },
        { label: 'Open the Arena Overview', ws: 'console' },
        { label: 'Check Arena Status', ws: 'arena-status' },
      ],
    },
    'arena': {
      greeting: 'The Arena. This is where it gets loud.',
      describe: 'Wave after wave of adversarial trials hit the model here. I\'ll show you who\'s still standing and who went down.',
      options: [
        { label: 'View results', ws: 'results' },
        { label: 'Check history', ws: 'history-ws' },
        { label: 'Back to the gate', go: 'main-gate' },
      ],
    },
    'training-grounds': {
      greeting: 'Training Grounds. We warm up before the real fight.',
      describe: 'Stress racks and ramp-up drills. Break things early here, so they don\'t break later in front of the crowd.',
      options: [
        { label: 'Trial configuration', ws: 'trial-config' },
        { label: 'View results', ws: 'results' },
        { label: 'Back to the gate', go: 'main-gate' },
      ],
    },
    'temple': {
      greeting: 'The Temple. Quiet down — we keep the records here.',
      describe: 'Every regression is studied, every drift noticed. This is where we make sure old wounds don\'t reopen.',
      options: [
        { label: 'View full history', ws: 'history-ws' },
        { label: 'Check results', ws: 'results' },
        { label: 'Back to the gate', go: 'main-gate' },
      ],
    },
    'armory': {
      greeting: 'The Armory. Mind the sharp edges.',
      describe: 'Every failure that comes out of the pit gets disassembled here — receipts, error patterns, root causes. We learn the weapon by taking it apart.',
      options: [
        { label: 'View receipts', ws: 'receipts' },
        { label: 'Check results', ws: 'results' },
        { label: 'Back to the gate', go: 'main-gate' },
      ],
    },
    'market': {
      greeting: 'The Market. Everything endurance trades here.',
      describe: 'Sustained runs, fatigue curves, resilience scores — the receipts of who lasted. Good place to judge stamina, not just a single swing.',
      options: [
        { label: 'Browse receipts', ws: 'receipts' },
        { label: 'View agents', ws: 'agents-ws' },
        { label: 'Back to the gate', go: 'main-gate' },
      ],
    },
  };

  // A few alternate openers so repeated visits don't feel scripted. Indexed
  // by a per-scene visit counter held in app.js (passed in as `nth`).
  var RETURN_OPENERS = [
    'Back again? Good. Keep your eyes up.',
    'You know this place now. Lead the way.',
    'Still standing. I like that. Where to?',
  ];

  var PehGuide = {
    name: 'Peh',
    pronoun: 'he',

    // Return the guide payload for a scene. `nth` = how many times you've
    // arrived here this session (1 = first). Unknown scenes get a safe default.
    forScene: function (sceneId, nth) {
      var g = GUIDE[sceneId];
      if (!g) {
        return {
          greeting: 'New ground. Let\'s have a look around.',
          describe: 'I don\'t have notes on this place yet — explore and I\'ll keep up.',
          options: [{ label: 'Back to the gate', go: 'main-gate' }],
        };
      }
      var greeting = (nth && nth > 1)
        ? RETURN_OPENERS[(nth - 2) % RETURN_OPENERS.length]
        : g.greeting;
      return { greeting: greeting, describe: g.describe, options: g.options.slice() };
    },

    // A short status-aware line Peh says about live data for a scene.
    // `digest` is the {note, stats} object from HowaScenes; ok=false means
    // the backend is unreachable.
    remark: function (digest, ok) {
      if (!ok) return 'I can\'t reach the backend from here — I\'ll show you the layout, but the numbers are dark.';
      if (digest && digest.note) return digest.note;
      return 'All quiet. Nothing to report yet.';
    },
  };

  global.PehGuide = PehGuide;
})(typeof window !== 'undefined' ? window : this);

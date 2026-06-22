// ══════════════════════════════════════════════════════════════════════
// HOWA · peh-onboarding.js — Peh's first-launch onboarding overlay.
// Checks localStorage 'pehverse-onboarded'. If absent, shows a
// semi-transparent overlay with Peh centered and a speech bubble.
// "Yes, show me around" walks the user through every hotspot in the
// current scene using pehSayGreeting(). "Skip" dismisses immediately.
// Clicking the Peh medallion or the help (?) button re-triggers it.
// ══════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  var ONBOARD_KEY = 'pehverse-onboarded';
  var TOUR_DELAY_MS = 1800; // 1–2 s between stops

  // ── Helpers ─────────────────────────────────────────────────────────
  function isOnboarded() {
    try { return localStorage.getItem(ONBOARD_KEY) === '1'; } catch (e) { return false; }
  }
  function markOnboarded() {
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) {}
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ── Build overlay DOM ───────────────────────────────────────────────
  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'peh-onboard-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Peh — welcome');

    overlay.innerHTML =
      '<div class="peh-onboard-card">' +
        '<div class="peh-onboard-portrait">' +
          '<img src="assets/peh-howa.png" alt="Pehlichi" width="120" height="120">' +
        '</div>' +
        '<div class="peh-onboard-bubble">' +
          '<span class="peh-onboard-name">Peh</span>' +
          '<p class="peh-onboard-text">' +
            'Halito! My name is Pehlichi, but my friends call me Peh. ' +
            'I will be joining you on this new adventure. ' +
            'Would you like to get started?' +
          '</p>' +
        '</div>' +
        '<div class="peh-onboard-actions">' +
          '<button class="peh-onboard-btn primary" type="button" data-action="tour">' +
            'Yes, show me around' +
          '</button>' +
          '<button class="peh-onboard-btn secondary" type="button" data-action="skip">' +
            'Skip — I know what I\'m doing' +
          '</button>' +
        '</div>' +
      '</div>';

    // Wire buttons
    overlay.querySelector('[data-action="tour"]').onclick = function () { startTour(overlay); };
    overlay.querySelector('[data-action="skip"]').onclick = function () { dismissOverlay(overlay); };

    return overlay;
  }

  // ── Show / dismiss overlay ──────────────────────────────────────────
  function showOverlay() {
    // Remove any existing overlay first
    dismissOverlaySilent();
    var overlay = buildOverlay();
    document.body.appendChild(overlay);
    // Trigger enter animation on next frame
    requestAnimationFrame(function () { overlay.classList.add('visible'); });
  }

  function dismissOverlay(overlay) {
    markOnboarded();
    if (!overlay) overlay = document.querySelector('.peh-onboard-overlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    overlay.classList.add('exiting');
    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 320);
  }

  function dismissOverlaySilent() {
    var old = document.querySelector('.peh-onboard-overlay');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  // ── Guided tour ─────────────────────────────────────────────────────
  function startTour(overlay) {
    // Fade out the card, then begin walking through hotspots
    overlay.classList.remove('visible');
    overlay.classList.add('exiting');
    setTimeout(function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      runTour();
    }, 320);
  }

  function runTour() {
    var scene = (typeof pehCurrentScene === 'function') ? pehCurrentScene() : null;
    if (!scene || !scene.hotspots || !scene.hotspots.length) {
      finishTour();
      return;
    }

    var hotspots = scene.hotspots.slice();
    var i = 0;

    function visitNext() {
      if (i >= hotspots.length) {
        finishTour();
        return;
      }
      var h = hotspots[i];
      i++;
      if (typeof pehSayGreeting === 'function') {
        pehSayGreeting(h, scene);
      }
      setTimeout(visitNext, TOUR_DELAY_MS);
    }

    visitNext();
  }

  function finishTour() {
    markOnboarded();

    // Show a completion bubble near Peh's current position
    var scene = (typeof pehCurrentScene === 'function') ? pehCurrentScene() : null;
    var slot = (scene && scene.pehSlot) ? scene.pehSlot : { x: 50, y: 50 };

    if (typeof pehClearBubbleTimers === 'function') pehClearBubbleTimers();

    // Set bubble state directly
    if (typeof state !== 'undefined' && state.pehverse) {
      state.pehverse.pehBubble = {
        text: 'You\'re all set! Click on any area to explore.',
        x: slot.x,
        y: slot.y,
        anchor: (slot.y != null && slot.y < 24) ? 'down' : 'up',
        variant: (scene && scene.pehSlot && scene.pehSlot.variant) || 'sentinel',
        hotspotId: '__tour-done__',
        phase: 'enter'
      };
      if (typeof render === 'function') render();

      // Auto-fade after a generous read period
      if (typeof pehBubbleFadeTimer !== 'undefined') {
        // Clear any previous fade timer
        if (window.__pehOnboardFade) clearTimeout(window.__pehOnboardFade);
        window.__pehOnboardFade = setTimeout(function () {
          window.__pehOnboardFade = null;
          if (typeof pehDismissBubble === 'function') {
            pehDismissBubble();
          }
        }, 8000);
      }
    }
  }

  // ── Re-trigger: help button ─────────────────────────────────────────
  function buildHelpButton() {
    var btn = document.createElement('button');
    btn.className = 'peh-onboard-help';
    btn.type = 'button';
    btn.title = 'Replay Peh\'s introduction';
    btn.setAttribute('aria-label', 'Replay onboarding tour');
    btn.textContent = '?';
    btn.onclick = function () { showOverlay(); };
    document.body.appendChild(btn);
  }

  // ── Re-trigger: click Peh medallion ─────────────────────────────────
  function hookMedallionClick() {
    document.addEventListener('click', function (e) {
      var medallion = e.target.closest('.peh-slot-medallion');
      if (!medallion) return;
      // Only re-trigger on double-click to avoid conflicting with other interactions
      // Actually, use a dedicated handler — single click on the medallion
      // in the topbar brand area
    });
  }

  // Expose for external re-trigger (e.g. from command bar)
  window.PehOnboarding = {
    show: showOverlay,
    isOnboarded: isOnboarded
  };

  // ── Boot ────────────────────────────────────────────────────────────
  function init() {
    buildHelpButton();

    if (!isOnboarded()) {
      // Small delay to let the main UI render first
      setTimeout(showOverlay, 400);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

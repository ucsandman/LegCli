/* Baton site: copy buttons and the live handoff terminal. The transcript is
   real text in the DOM at all times; this file only reveals it line by line. */
(function () {
  'use strict';

  // Copy buttons: verb label, turns to "copied" for 1.4 s. Five buttons share
  // one visible label, so each carries its own aria-label in the markup, and
  // the result is announced through one polite live region: a label swap on the
  // focused button is not reliably read out.
  var copyStatus = document.getElementById('copy-status');
  document.querySelectorAll('.copy[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      var done = function () {
        btn.textContent = 'copied';
        btn.setAttribute('data-done', '1');
        if (copyStatus) copyStatus.textContent = 'Copied ' + text;
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.removeAttribute('data-done');
          if (copyStatus) copyStatus.textContent = '';
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
      } else { fallback(text); done(); }
    });
  });
  function fallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* the text is visible on the page */ }
    document.body.removeChild(ta);
  }

  // Live terminal.
  var term = document.getElementById('term');
  if (!term) return;
  var body = document.getElementById('term-body');
  var lines = Array.prototype.slice.call(body.querySelectorAll('.ln'));
  var strip = document.getElementById('strip');
  var rail5 = document.getElementById('rail5');
  var rail7 = document.getElementById('rail7');
  var num5 = document.getElementById('num5');
  var num7 = document.getElementById('num7');
  var tier = document.getElementById('strip-tier');
  var bell = document.getElementById('bell');
  var who = document.getElementById('strip-who');
  var replay = document.getElementById('replay');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var timers = [];
  var typedText = lines.map(function (ln) { return ln.getAttribute('data-type') ? ln.textContent : null; });

  // The rail, as src/board/board.css draws it: one gradient with hard stops
  // computed from the value, so the fill shows the zones it crossed and red is
  // confined to the part past the 85 post.
  function fillStops(pct) {
    return { s60: pct <= 60 ? 100 : (60 / pct) * 100, s85: pct <= 85 ? 100 : (85 / pct) * 100 };
  }
  function setRail(rail, num, kind, pct) {
    var stops = fillStops(pct);
    rail.querySelector('.track').style.setProperty('--pct', pct + '%');
    var fill = rail.querySelector('.fill');
    fill.style.setProperty('--s60', stops.s60.toFixed(1) + '%');
    fill.style.setProperty('--s85', stops.s85.toFixed(1) + '%');
    num.firstChild.nodeValue = String(pct);
    num.className = 'num num-' + kind + (pct >= 85 ? ' is-danger' : pct >= 60 ? ' is-warn' : '');
  }
  // R4 prints one word for the account, from the window with the worst reading.
  function setTier(word, cls) { tier.textContent = word; tier.className = cls ? 'tier ' + cls : 'tier'; }
  function setOwner(agent, label) {
    term.setAttribute('data-owner', agent);
    who.textContent = label;
    who.className = 'acct-name id-' + agent;
  }
  function finalState() {
    setOwner('codex', 'codex/personal');
    strip.classList.remove('is-walled');
    setRail(rail5, num5, '5h', 18); setRail(rail7, num7, '7d', 12);
    setTier('under 60', '');
    bell.removeAttribute('data-on');
  }
  function startState() {
    setOwner('claude', 'claude/work');
    strip.classList.remove('is-walled');
    setRail(rail5, num5, '5h', 41); setRail(rail7, num7, '7d', 18);
    setTier('under 60', '');
    bell.removeAttribute('data-on');
  }
  function showAll() {
    lines.forEach(function (ln, i) { ln.hidden = false; ln.classList.remove('caret'); if (typedText[i] !== null) ln.textContent = typedText[i]; });
    finalState();
  }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function at(ms, fn) { timers.push(setTimeout(fn, ms)); }

  // `keep` is the first run from the IntersectionObserver: the two pre-rolled
  // lines are already on screen, so wiping them would blank the panel for 300ms
  // before the sequence starts. Replay wipes everything, where a reset is what
  // the reader asked for.
  function play(keep) {
    clearTimers();
    startState();
    lines.forEach(function (ln, i) {
      if (keep && i <= 1) return;
      ln.hidden = true; ln.classList.remove('caret'); if (typedText[i] !== null) ln.textContent = '';
    });
    replay.hidden = true;
    var t = keep ? 0 : 300;
    lines.forEach(function (ln, i) {
      if (keep && i <= 1) { t += 260; return; }
      var text = typedText[i];
      if (text !== null) {
        // Type the human and pointer prompts character by character.
        var perChar = text.length > 120 ? 9 : 26;
        at(t, function () { ln.hidden = false; ln.classList.add('caret'); });
        for (var c = 1; c <= text.length; c++) {
          (function (n) { at(t + n * perChar, function () { ln.textContent = text.slice(0, n); }); })(c);
        }
        t += text.length * perChar + 380;
        at(t, function () { ln.classList.remove('caret'); });
      } else {
        at(t, function () { ln.hidden = false; });
        t += ln.classList.contains('gap') ? 120 : (ln.classList.contains('baton') ? 700 : 520);
      }
      // the fill crosses 60 before it crosses the post at 85, and the board
      // prints a word for that band too
      if (ln.getAttribute('data-warn60')) {
        at(t - 200, function () { setRail(rail5, num5, '5h', 68); setTier('over 60', 'is-warn'); });
        t += 600;
      }
      if (ln.getAttribute('data-warn')) {
        at(t - 200, function () { setRail(rail5, num5, '5h', 85); setTier('over 85', 'is-danger'); bell.setAttribute('data-on', '1'); });
        t += 900;
      }
      if (ln.getAttribute('data-limit')) {
        at(t - 500, function () { setRail(rail5, num5, '5h', 100); strip.classList.add('is-walled'); setTier('at the wall', 'is-walled'); });
        t += 500;
      }
      if (ln.getAttribute('data-switch')) {
        at(t, function () { finalState(); });
        t += 600;
      }
      if (ln.getAttribute('data-last')) {
        at(t + 200, function () { replay.hidden = false; });
      }
    });
  }

  if (reduce || !('IntersectionObserver' in window)) {
    showAll();
    return;
  }

  // Before the section is reached, hold the terminal at its opening state so
  // the sequence is seen from the start; the full text stays in the DOM.
  lines.forEach(function (ln, i) { if (i > 1) ln.hidden = true; if (typedText[i] !== null) ln.textContent = ''; });
  var played = false;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting && !played) { played = true; play(true); io.disconnect(); }
    });
  }, { threshold: 0.35 });
  io.observe(term);
  replay.addEventListener('click', function () { play(false); });
})();

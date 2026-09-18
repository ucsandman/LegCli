/* Leg site: copy buttons and the live handoff terminal. The transcript is
   real text in the DOM at all times; this file only reveals it line by line. */
(function () {
  'use strict';

  // Copy buttons: verb label, turns to "Copied" for 1.4 s.
  document.querySelectorAll('.copy[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      var done = function () {
        btn.textContent = 'Copied';
        btn.setAttribute('data-done', '1');
        setTimeout(function () { btn.textContent = 'Copy'; btn.removeAttribute('data-done'); }, 1400);
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
  var bar5 = document.getElementById('bar5');
  var bar7 = document.getElementById('bar7');
  var bell = document.getElementById('bell');
  var who = document.getElementById('strip-who');
  var acct = document.getElementById('strip-acct');
  var replay = document.getElementById('replay');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var timers = [];
  var typedText = lines.map(function (ln) { return ln.getAttribute('data-type') ? ln.textContent : null; });

  function setBar(el, pct, state, label) {
    el.querySelector('i').style.setProperty('--p', String(pct / 100));
    el.querySelector('b').textContent = pct + '%';
    el.setAttribute('data-state', state);
    if (label) el.querySelector('span').textContent = label;
  }
  // Three states: claude on fable (the fable week filling), claude on opus after
  // the model wall (same login, same conversation), codex after the login wall.
  function finalState() {
    term.setAttribute('data-owner', 'codex');
    who.textContent = 'codex'; acct.textContent = 'wes@personal';
    setBar(bar5, 18, 'ok', '5h'); setBar(bar7, 12, 'ok', '7d');
    bell.removeAttribute('data-on');
  }
  function opusState() {
    term.setAttribute('data-owner', 'claude');
    who.textContent = 'claude/opus'; acct.textContent = 'wes@work';
    setBar(bar5, 41, 'ok', '5h'); setBar(bar7, 12, 'ok', 'opus week');
    bell.removeAttribute('data-on');
  }
  function startState() {
    term.setAttribute('data-owner', 'claude');
    who.textContent = 'claude/fable'; acct.textContent = 'wes@work';
    setBar(bar5, 41, 'ok', '5h'); setBar(bar7, 79, 'ok', 'fable week');
    bell.removeAttribute('data-on');
  }
  function showAll() {
    lines.forEach(function (ln, i) { ln.hidden = false; ln.classList.remove('caret'); if (typedText[i] !== null) ln.textContent = typedText[i]; });
    finalState();
  }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function at(ms, fn) { timers.push(setTimeout(fn, ms)); }

  function play() {
    clearTimers();
    startState();
    lines.forEach(function (ln, i) { ln.hidden = true; ln.classList.remove('caret'); if (typedText[i] !== null) ln.textContent = ''; });
    replay.hidden = true;
    var t = 300;
    lines.forEach(function (ln, i) {
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
        t += ln.classList.contains('gap') ? 120 : ((ln.classList.contains('leg') || ln.classList.contains('baton')) ? 700 : 520);
      }
      var warn = ln.getAttribute('data-warn');
      if (warn) {
        // "7" is the fable week crossing its notch; "5" is the login's 5h window.
        at(t - 200, function () { setBar(warn === '5' ? bar5 : bar7, 85, 'warn'); bell.setAttribute('data-on', '1'); });
        t += 900;
      }
      var limit = ln.getAttribute('data-limit');
      if (limit) {
        at(t - 500, function () { setBar(limit === 'account' ? bar5 : bar7, 100, 'limit'); });
        t += 500;
      }
      var sw = ln.getAttribute('data-switch');
      if (sw) {
        at(t, sw === 'opus' ? opusState : finalState);
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
      if (e.isIntersecting && !played) { played = true; play(); io.disconnect(); }
    });
  }, { threshold: 0.35 });
  io.observe(term);
  replay.addEventListener('click', play);
})();

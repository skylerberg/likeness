(function () {
  'use strict';

  // ---------- Config ----------
  const DATAMUSE = 'https://api.datamuse.com/words';
  const SHARE_URL_BASE = location.origin + location.pathname;

  const MOVE = {
    start:     { emoji: '🏁', label: 'start',     counts: false },
    add:       { emoji: '➕', label: 'added',     counts: true  },
    remove:    { emoji: '➖', label: 'removed',   counts: true  },
    synonym:   { emoji: '🔄', label: 'synonym',   counts: false },
    homophone: { emoji: '🔊', label: 'homophone', counts: false }
  };

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);

  const els = {
    startWord: $('start-word'),
    targetWord: $('target-word'),
    meaningBar: $('meaning-bar'),
    meaningValue: $('meaning-value'),
    soundBar: $('sound-bar'),
    soundValue: $('sound-value'),
    lettersValue: $('letters-value'),
    history: $('history'),
    moveForm: $('move-form'),
    moveInput: $('move-input'),
    moveSubmit: $('move-submit'),
    status: $('status'),
    stepCount: $('step-count'),
    stepPlural: $('step-plural'),
    freeCount: $('free-count'),
    freePlural: $('free-plural'),
    giveUpBtn: $('give-up-btn'),
    howToBtn: $('how-to-btn'),
    newGameBtn: $('new-game-btn'),
    howToDialog: $('how-to-dialog'),
    winCard: $('win-card'),
    winStart: $('win-start'),
    winTarget: $('win-target'),
    winSteps: $('win-steps'),
    winStepsPlural: $('win-steps-plural'),
    sharePreview: $('share-preview'),
    shareBtn: $('share-btn'),
    continueBtn: $('continue-btn')
  };

  // ---------- State ----------
  /** @type {{start:string,target:string,history:Array<{word:string,type:string}>,won:boolean,gaveUp:boolean,targetMl:any[]|null,targetSl:any[]|null}} */
  let state;

  // ---------- Word utilities ----------
  function clean(word) {
    return (word || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  }

  function lcsLen(a, b) {
    const n = a.length, m = b.length;
    if (!n || !m) return 0;
    let prev = new Array(m + 1).fill(0);
    let cur = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        if (a[i - 1] === b[j - 1]) cur[j] = prev[j - 1] + 1;
        else cur[j] = Math.max(prev[j], cur[j - 1]);
      }
      [prev, cur] = [cur, prev];
      cur.fill(0);
    }
    return prev[m];
  }

  function letterDiff(a, b) {
    const l = lcsLen(a, b);
    return { remove: a.length - l, add: b.length - l };
  }

  function isOneAdd(prev, next) {
    if (next.length !== prev.length + 1) return false;
    for (let i = 0; i <= prev.length; i++) {
      if (next.slice(0, i) + next.slice(i + 1) === prev) return true;
    }
    return false;
  }

  function isOneRemove(prev, next) {
    return isOneAdd(next, prev);
  }

  // ---------- Datamuse wrapper ----------
  const apiCache = new Map();

  async function dm(params) {
    const url = `${DATAMUSE}?${new URLSearchParams(params)}`;
    if (apiCache.has(url)) return apiCache.get(url);
    const promise = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Datamuse ${r.status}`);
      return r.json();
    });
    apiCache.set(url, promise);
    try {
      return await promise;
    } catch (err) {
      apiCache.delete(url);
      throw err;
    }
  }

  async function isRealWord(word) {
    try {
      const res = await dm({ sp: word, max: 1 });
      return Array.isArray(res) && res.length > 0 && res[0].word.toLowerCase() === word.toLowerCase();
    } catch {
      return false;
    }
  }

  async function synList(word) {
    try {
      return await dm({ rel_syn: word, max: 200 });
    } catch { return []; }
  }

  async function homList(word) {
    try {
      return await dm({ rel_hom: word, max: 50 });
    } catch { return []; }
  }

  async function meanLikeList(word) {
    try {
      return await dm({ ml: word, max: 1000 });
    } catch { return []; }
  }

  async function soundLikeList(word) {
    try {
      return await dm({ sl: word, max: 1000 });
    } catch { return []; }
  }

  function listHas(list, word) {
    const w = word.toLowerCase();
    return list.some((r) => r.word && r.word.toLowerCase() === w);
  }

  async function areSynonyms(a, b) {
    if (a === b) return false;
    const [aS, bS] = await Promise.all([synList(a), synList(b)]);
    if (listHas(aS, b) || listHas(bS, a)) return true;
    // Fallback: very-high "means like" score in either direction.
    const aM = await meanLikeList(a);
    const m = aM.find((r) => r.word && r.word.toLowerCase() === b);
    if (m && m.score && m.score >= 100000) return true;
    return false;
  }

  async function areHomophones(a, b) {
    if (a === b) return false;
    const [aH, bH] = await Promise.all([homList(a), homList(b)]);
    return listHas(aH, b) || listHas(bH, a);
  }

  // ---------- Move classification ----------
  // Returns { type, reason } where type is one of MOVE keys, or
  // { type: null, reason } describing why the move was rejected.
  async function classifyMove(prev, next) {
    if (prev === next) return { type: null, reason: 'same' };
    if (!(await isRealWord(next))) return { type: null, reason: 'unknown' };
    if (isOneAdd(prev, next)) return { type: 'add' };
    if (isOneRemove(prev, next)) return { type: 'remove' };
    if (await areHomophones(prev, next)) return { type: 'homophone' };
    if (await areSynonyms(prev, next)) return { type: 'synonym' };
    return { type: null, reason: 'unrelated' };
  }

  // ---------- Scoring helpers ----------
  function rankScore(list, word) {
    if (!list || !list.length) return 0;
    const w = word.toLowerCase();
    const idx = list.findIndex((r) => r.word && r.word.toLowerCase() === w);
    if (idx === -1) return 0;
    // Linear: top of the list ≈ 100, tail ≈ 1.
    return Math.max(1, Math.round(100 * (1 - idx / list.length)));
  }

  // ---------- Rendering ----------
  function setBar(el, pct) {
    el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.className = 'status' + (kind ? ` ${kind}` : '');
  }

  function up(word) { return (word || '').toUpperCase(); }

  function renderEndpoints() {
    els.startWord.textContent = up(state.start);
    els.targetWord.textContent = up(state.target);
  }

  function renderHistory() {
    els.history.innerHTML = '';
    const items = [{ word: state.start, type: 'start' }, ...state.history];
    items.forEach((entry, i) => {
      const li = document.createElement('li');
      const isLast = i === items.length - 1;
      const reachedTarget = state.won && isLast;
      li.classList.toggle('is-current', isLast && !reachedTarget);
      li.classList.toggle('is-start', i === 0);
      li.classList.toggle('is-target', reachedTarget);

      const move = MOVE[entry.type];
      const emoji = document.createElement('span');
      emoji.className = 'move-emoji';
      emoji.textContent = move.emoji;

      const word = document.createElement('span');
      word.className = 'move-word';
      word.textContent = up(entry.word);

      const tag = document.createElement('span');
      tag.className = 'move-tag';
      if (entry.type === 'start') tag.textContent = 'start';
      else if (reachedTarget) tag.textContent = 'target!';
      else tag.textContent = move.label + (move.counts ? '' : ' · free');

      li.appendChild(emoji);
      li.appendChild(word);
      li.appendChild(tag);
      els.history.appendChild(li);
    });
    els.history.parentElement.scrollTop = els.history.parentElement.scrollHeight;
  }

  function renderCounters() {
    const steps = state.history.filter((m) => MOVE[m.type].counts).length;
    const freebies = state.history.length - steps;
    els.stepCount.textContent = String(steps);
    els.stepPlural.textContent = steps === 1 ? '' : 's';
    els.freeCount.textContent = String(freebies);
    els.freePlural.textContent = freebies === 1 ? '' : 's';
  }

  async function refreshMetrics() {
    const current = currentWord();
    const target = state.target;

    const diff = letterDiff(current, target);
    if (current === target) {
      els.lettersValue.textContent = 'match';
    } else {
      els.lettersValue.textContent = `+${diff.add} / −${diff.remove}`;
    }

    if (current === target) {
      setBar(els.meaningBar, 100);
      setBar(els.soundBar, 100);
      els.meaningValue.textContent = '100%';
      els.soundValue.textContent = '100%';
      return;
    }

    // Lazily fetch and cache target reference lists.
    if (!state.targetMl) state.targetMl = await meanLikeList(target);
    if (!state.targetSl) state.targetSl = await soundLikeList(target);

    const meaning = rankScore(state.targetMl, current);
    const sound = rankScore(state.targetSl, current);
    setBar(els.meaningBar, meaning);
    setBar(els.soundBar, sound);
    els.meaningValue.textContent = `${meaning}%`;
    els.soundValue.textContent = `${sound}%`;
  }

  function currentWord() {
    if (!state.history.length) return state.start;
    return state.history[state.history.length - 1].word;
  }

  // ---------- Sharing ----------
  function chainUrl(start) {
    const url = new URL(SHARE_URL_BASE);
    url.searchParams.set('start', start);
    return url.toString();
  }

  function shareText() {
    const steps = state.history.filter((m) => MOVE[m.type].counts).length;
    const frees = state.history.length - steps;
    const lines = [];
    lines.push(`Likeness 🔗 ${up(state.start)} → ${up(state.target)}`);
    lines.push(`${steps} step${steps === 1 ? '' : 's'} · ${frees} free`);
    const emojiTrail = state.history.map((m) => MOVE[m.type].emoji).join(' ');
    if (emojiTrail) lines.push(emojiTrail);
    lines.push('');
    lines.push(`Continue the chain → ${chainUrl(state.target)}`);
    return lines.join('\n');
  }

  function renderWin() {
    els.winStart.textContent = up(state.start);
    els.winTarget.textContent = up(state.target);
    const steps = state.history.filter((m) => MOVE[m.type].counts).length;
    els.winSteps.textContent = String(steps);
    els.winStepsPlural.textContent = steps === 1 ? '' : 's';
    els.sharePreview.textContent = shareText();
    els.winCard.classList.remove('hidden');
    els.winCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function doShare() {
    const text = shareText();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Likeness', text });
        return;
      } catch { /* fall through to clipboard */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied your chain to the clipboard.', 'success');
    } catch {
      setStatus('Could not copy automatically — long-press the box to copy.', 'info');
    }
  }

  // ---------- Move submission ----------
  let submitting = false;

  async function submitMove(rawInput) {
    if (state.won || submitting) return;
    const next = clean(rawInput);
    if (!next) {
      setStatus('Type a word first.', 'error');
      shakeInput();
      return;
    }
    if (next.length < 2) {
      setStatus('Words need at least two letters.', 'error');
      shakeInput();
      return;
    }
    const prev = currentWord();
    if (next === prev) {
      setStatus(`That's the same word you already have.`, 'error');
      shakeInput();
      return;
    }
    if (state.history.some((m) => m.word === next)) {
      setStatus(`You've already used ${up(next)} in this chain.`, 'error');
      shakeInput();
      return;
    }

    submitting = true;
    els.moveSubmit.disabled = true;
    setStatus('Checking…', 'info');

    let result;
    try {
      result = await classifyMove(prev, next);
    } catch (err) {
      submitting = false;
      els.moveSubmit.disabled = false;
      setStatus('Network hiccup — try again in a moment.', 'error');
      return;
    }

    if (!result.type) {
      submitting = false;
      els.moveSubmit.disabled = false;
      const msg = result.reason === 'unknown'
        ? `${up(next)} isn't a word I recognise.`
        : `${up(next)} isn't a ±1 letter, synonym, or homophone of ${up(prev)}.`;
      setStatus(msg, 'error');
      shakeInput();
      return;
    }

    const type = result.type;
    state.history.push({ word: next, type });
    els.moveInput.value = '';
    setStatus(`${MOVE[type].emoji} ${MOVE[type].label}${MOVE[type].counts ? '' : ' (free)'}`, 'success');
    renderHistory();
    renderCounters();

    if (next === state.target) {
      state.won = true;
      els.moveInput.disabled = true;
      els.moveSubmit.disabled = true;
      await refreshMetrics();
      renderWin();
    } else {
      await refreshMetrics();
      submitting = false;
      els.moveSubmit.disabled = false;
      els.moveInput.focus();
    }
  }

  function shakeInput() {
    els.moveInput.classList.remove('shake');
    // Force reflow to restart animation.
    // eslint-disable-next-line no-unused-expressions
    void els.moveInput.offsetWidth;
    els.moveInput.classList.add('shake');
  }

  // ---------- New game / routing ----------
  function pickRandomDifferent(exclude) {
    const pool = (window.LIKENESS_WORDS || []).filter((w) => w !== exclude);
    if (!pool.length) return 'word';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function newGame({ start, target } = {}) {
    const s = clean(start) || pickRandomDifferent('');
    const t = clean(target) || pickRandomDifferent(s);
    state = {
      start: s,
      target: t,
      history: [],
      won: false,
      gaveUp: false,
      targetMl: null,
      targetSl: null
    };
    els.moveInput.disabled = false;
    els.moveSubmit.disabled = false;
    els.moveInput.value = '';
    els.winCard.classList.add('hidden');
    setStatus('');
    renderEndpoints();
    renderHistory();
    renderCounters();
    refreshMetrics();
    els.moveInput.focus();
  }

  function readUrlParams() {
    const u = new URL(location.href);
    return {
      start: u.searchParams.get('start') || '',
      target: u.searchParams.get('target') || ''
    };
  }

  function clearUrl() {
    history.replaceState({}, '', location.pathname);
  }

  // ---------- Wire up ----------
  function init() {
    const params = readUrlParams();
    newGame(params);

    els.moveForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitMove(els.moveInput.value);
    });

    els.giveUpBtn.addEventListener('click', () => {
      if (state.won) return;
      if (!confirm('Give up on this puzzle and start a new one?')) return;
      clearUrl();
      newGame();
    });

    els.newGameBtn.addEventListener('click', () => {
      clearUrl();
      newGame();
    });

    els.howToBtn.addEventListener('click', () => {
      if (typeof els.howToDialog.showModal === 'function') els.howToDialog.showModal();
      else els.howToDialog.setAttribute('open', '');
    });

    els.shareBtn.addEventListener('click', doShare);
    els.continueBtn.addEventListener('click', () => {
      const next = state.target;
      history.replaceState({}, '', `${location.pathname}?start=${encodeURIComponent(next)}`);
      newGame({ start: next });
    });

    // Show how-to on very first visit.
    try {
      if (!localStorage.getItem('likeness-seen-howto')) {
        localStorage.setItem('likeness-seen-howto', '1');
        if (typeof els.howToDialog.showModal === 'function') els.howToDialog.showModal();
      }
    } catch { /* private mode etc. */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

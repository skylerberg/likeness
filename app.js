(function () {
  'use strict';

  // ---------- Config ----------
  const DATAMUSE = 'https://api.datamuse.com/words';
  const SHARE_URL_BASE = location.origin + location.pathname;

  const MOVE = {
    start:     { emoji: '🏁', label: 'start'     },
    add:       { emoji: '➕', label: 'added'     },
    remove:    { emoji: '➖', label: 'removed'   },
    replace:   { emoji: '🔁', label: 'replaced'  },
    anagram:   { emoji: '🔀', label: 'anagram'   },
    synonym:   { emoji: '🔄', label: 'synonym'   },
    homophone: { emoji: '🔊', label: 'homophone' }
  };

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);

  const els = {
    startWord: $('start-word'),
    targetWord: $('target-word'),
    history: $('history'),
    moveForm: $('move-form'),
    moveInput: $('move-input'),
    moveSubmit: $('move-submit'),
    status: $('status'),
    stepCount: $('step-count'),
    stepPlural: $('step-plural'),
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
  /** @type {{start:string,target:string,history:Array<{word:string,type:string}>,won:boolean,gaveUp:boolean}} */
  let state;

  // ---------- Word utilities ----------
  function clean(word) {
    return (word || '').trim().toLowerCase().replace(/[^a-z]/g, '');
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

  function isOneReplace(prev, next) {
    if (prev.length !== next.length || prev === next) return false;
    let diffs = 0;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== next[i]) {
        diffs++;
        if (diffs > 1) return false;
      }
    }
    return diffs === 1;
  }

  function isAnagram(prev, next) {
    if (prev.length !== next.length || prev === next) return false;
    const sortLetters = (s) => s.split('').sort().join('');
    return sortLetters(prev) === sortLetters(next);
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

  // A word counts as "real" only if Datamuse returns it as an exact spelling
  // match AND tags it with a content part of speech (n/v/adj/adv) AND has a
  // frequency entry above a small minimum. The POS check alone leaks proper-
  // noun-style entries like surnames (still tagged "n") that aren't English
  // words for game purposes. Requiring an f:<freq> tag with a non-trivial
  // value filters those out: real English words appear in the reference
  // corpus and carry a usable frequency; obscure dictionary cruft typically
  // doesn't.
  const REAL_POS_TAGS = new Set(['n', 'v', 'adj', 'adv']);
  // Per-million-words. 0.05 = roughly 1 occurrence per 20 million words —
  // permissive enough for unusual-but-real words ("lummox", "snog") while
  // still rejecting the long tail of proper nouns and odd entries.
  const MIN_WORD_FREQUENCY = 0.05;

  function frequencyFromTags(tags) {
    if (!Array.isArray(tags)) return 0;
    const f = tags.find((t) => typeof t === 'string' && t.startsWith('f:'));
    if (!f) return 0;
    const n = parseFloat(f.slice(2));
    return Number.isFinite(n) ? n : 0;
  }

  async function isRealWord(word) {
    try {
      const res = await dm({ sp: word, max: 1, md: 'p,f' });
      if (!Array.isArray(res) || res.length === 0) return false;
      const top = res[0];
      if (!top.word || top.word.toLowerCase() !== word.toLowerCase()) return false;
      const tags = Array.isArray(top.tags) ? top.tags : [];
      if (!tags.some((t) => REAL_POS_TAGS.has(t))) return false;
      return frequencyFromTags(tags) >= MIN_WORD_FREQUENCY;
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
      return await dm({ ml: word, max: 200 });
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
    if (isOneReplace(prev, next)) return { type: 'replace' };
    if (isAnagram(prev, next)) return { type: 'anagram' };
    if (await areHomophones(prev, next)) return { type: 'homophone' };
    if (await areSynonyms(prev, next)) return { type: 'synonym' };
    return { type: null, reason: 'unrelated' };
  }

  // ---------- Rendering ----------
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
      const isAtCursor = i === state.cursor;
      const isGhost = i > state.cursor;
      const reachedTarget = isAtCursor && state.won;
      li.classList.toggle('is-current', isAtCursor && !reachedTarget);
      li.classList.toggle('is-start', i === 0);
      li.classList.toggle('is-target', reachedTarget);
      li.classList.toggle('is-ghost', isGhost);

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
      else tag.textContent = move.label;

      li.appendChild(emoji);
      li.appendChild(word);
      li.appendChild(tag);

      if (!isAtCursor) {
        li.classList.add('is-rewindable');
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.title = isGhost
          ? `Step forward to ${up(entry.word)}`
          : `Step back to ${up(entry.word)}`;
        li.addEventListener('click', () => setCursor(i));
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setCursor(i);
          }
        });
      }

      els.history.appendChild(li);
    });
    els.history.parentElement.scrollTop = els.history.parentElement.scrollHeight;
  }

  function setCursor(i) {
    if (submitting) return;
    if (i === state.cursor) return;
    state.cursor = i;
    const atTarget = state.cursor > 0 && currentWord() === state.target;
    state.won = atTarget;
    saveState();
    els.moveInput.value = '';
    if (atTarget) {
      els.moveInput.disabled = true;
      els.moveSubmit.disabled = true;
      renderHistory();
      renderCounters();
      renderWin();
    } else {
      els.moveInput.disabled = false;
      els.moveSubmit.disabled = false;
      els.winCard.classList.add('hidden');
      renderHistory();
      renderCounters();
      setStatus(`Now at ${up(currentWord())}. Submit to take a new path.`, 'info');
      els.moveInput.focus();
    }
  }

  function renderCounters() {
    const steps = liveHistory().length;
    els.stepCount.textContent = String(steps);
    els.stepPlural.textContent = steps === 1 ? '' : 's';
  }

  // The cursor points into the items array [start, ...history]. cursor === 0
  // means the player is back at the start; cursor === k means they are at
  // history[k-1]. Anything in history past the cursor is "ghosted future" —
  // shown but not part of the live path until the player submits a new move
  // (which truncates the ghosted suffix and replaces it).
  function currentWord() {
    if (state.cursor === 0) return state.start;
    return state.history[state.cursor - 1].word;
  }

  function liveHistory() {
    return state.history.slice(0, state.cursor);
  }

  // ---------- Sharing ----------
  function chainUrl(start) {
    const url = new URL(SHARE_URL_BASE);
    url.searchParams.set('start', start);
    return url.toString();
  }

  function shareText() {
    const live = liveHistory();
    const steps = live.length;
    const lines = [];
    lines.push(`Likeness 🔗 ${up(state.start)} → ${up(state.target)}`);
    lines.push(`${steps} step${steps === 1 ? '' : 's'}`);
    const emojiTrail = live.map((m) => MOVE[m.type].emoji).join(' ');
    if (emojiTrail) lines.push(emojiTrail);
    lines.push('');
    lines.push(`Continue the chain → ${chainUrl(state.target)}`);
    return lines.join('\n');
  }

  function renderWin() {
    els.winStart.textContent = up(state.start);
    els.winTarget.textContent = up(state.target);
    const steps = liveHistory().length;
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
    if (liveHistory().some((m) => m.word === next)) {
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
        : `${up(next)} isn't a ±1 letter, letter swap, anagram, synonym, or homophone of ${up(prev)}.`;
      setStatus(msg, 'error');
      shakeInput();
      return;
    }

    const type = result.type;
    // Submitting from a rewound cursor commits the new branch: drop any
    // ghosted future, append the new move, advance the cursor to the tail.
    state.history.length = state.cursor;
    state.history.push({ word: next, type });
    state.cursor = state.history.length;
    saveState();
    els.moveInput.value = '';
    setStatus(`${MOVE[type].emoji} ${MOVE[type].label}`, 'success');
    renderHistory();
    renderCounters();

    submitting = false;
    if (next === state.target) {
      state.won = true;
      els.moveInput.disabled = true;
      els.moveSubmit.disabled = true;
      renderWin();
    } else {
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

  // ---------- Persistence ----------
  // Saved state lives in a single localStorage slot. On load, we restore the
  // chain only if the saved (start, target) pair matches what we'd otherwise
  // produce — so URL share links still take precedence, but a refresh while
  // playing keeps you where you were.
  const STORAGE_KEY = 'likeness:game:v1';

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        start: state.start,
        target: state.target,
        history: state.history,
        cursor: state.cursor
      }));
    } catch { /* private mode, quota, disabled — game still works */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.start !== 'string' || !parsed.start) return null;
      if (typeof parsed.target !== 'string' || !parsed.target) return null;
      if (!Array.isArray(parsed.history)) return null;
      if (typeof parsed.cursor !== 'number') return null;
      const historyOk = parsed.history.every((m) =>
        m && typeof m === 'object'
        && typeof m.word === 'string'
        && typeof m.type === 'string'
        && MOVE[m.type] && m.type !== 'start'
      );
      if (!historyOk) return null;
      if (parsed.cursor < 0 || parsed.cursor > parsed.history.length) return null;
      return parsed;
    } catch { return null; }
  }

  function clearSavedState() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
  }

  // ---------- New game / routing ----------
  function pickRandomDifferent(exclude) {
    const pool = (window.LIKENESS_WORDS || []).filter((w) => w !== exclude);
    if (!pool.length) return 'word';
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function newGame(opts = {}) {
    const urlStart = clean(opts.start);
    const urlTarget = clean(opts.target);
    const saved = loadState();

    let s, t, history = [], cursor = 0;

    if (urlStart) {
      s = urlStart;
    } else if (saved) {
      s = saved.start;
    } else {
      s = pickRandomDifferent('');
    }

    if (urlTarget) {
      t = urlTarget;
    } else if (saved && saved.start === s) {
      t = saved.target;
    } else {
      t = pickRandomDifferent(s);
    }

    if (saved && saved.start === s && saved.target === t) {
      history = saved.history;
      cursor = saved.cursor;
    }

    state = { start: s, target: t, history, cursor, won: false, gaveUp: false };
    state.won = state.cursor > 0 && currentWord() === state.target;

    submitting = false;
    els.moveInput.value = '';
    setStatus('');
    renderEndpoints();
    renderHistory();
    renderCounters();

    if (state.won) {
      els.moveInput.disabled = true;
      els.moveSubmit.disabled = true;
      renderWin();
    } else {
      els.moveInput.disabled = false;
      els.moveSubmit.disabled = false;
      els.winCard.classList.add('hidden');
      els.moveInput.focus();
    }

    saveState();
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
      clearSavedState();
      clearUrl();
      newGame();
    });

    els.newGameBtn.addEventListener('click', () => {
      clearSavedState();
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

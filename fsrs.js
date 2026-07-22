// FSRS scheduler — exact port of scripts/fsrs.py in the turkce data repo.
// Same FSRS-4.5 parameters, same grade mapping: user grades 0-3 where
// 0 (didn't get it) -> Again, then successes by ease: 1 (barely) -> Hard,
// 2 (normal) -> Good, 3 (instant) -> Easy. Grade 0 reschedules same-day.
// Any change here must keep tests/vectors.json (generated from fsrs.py) green.

const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
           1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const REQUEST_RETENTION = 0.9;
const FACTOR = 19.0 / 81.0;
const DECAY = -0.5;

// Python-style round-half-to-even (fsrs.py uses round(); JS Math.round differs on .5)
function pyRound(x, ndigits = 0) {
  const m = Math.pow(10, ndigits);
  const v = x * m;
  const f = Math.floor(v);
  const diff = v - f;
  let r;
  if (diff > 0.5) r = f + 1;
  else if (diff < 0.5) r = f;
  else r = (f % 2 === 0) ? f : f + 1;
  return r / m;
}

// ISO date (YYYY-MM-DD) helpers, all UTC to keep day arithmetic exact
function dateToMs(iso) {
  const [y, mo, d] = iso.split("-").map(Number);
  return Date.UTC(y, mo - 1, d);
}
function addDays(iso, days) {
  return new Date(dateToMs(iso) + days * 86400000).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((dateToMs(b) - dateToMs(a)) / 86400000);
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function retrievability(elapsedDays, stability) {
  if (stability <= 0) return 0.0;
  return Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
}

function initState(rating) {
  const stability = W[rating - 1];
  const difficulty = Math.min(Math.max(W[4] - (rating - 3) * W[5], 1.0), 10.0);
  return [stability, difficulty];
}

function nextState(stability, difficulty, elapsedDays, rating) {
  const r = retrievability(elapsedDays, stability);
  const d0Easy = W[4] - (4 - 3) * W[5];
  let d = difficulty - W[6] * (rating - 3);
  d = W[7] * d0Easy + (1 - W[7]) * d;
  d = Math.min(Math.max(d, 1.0), 10.0);
  let s;
  if (rating === 1) {
    s = W[11] * Math.pow(d, -W[12]) * (Math.pow(stability + 1, W[13]) - 1)
        * Math.exp(W[14] * (1 - r));
    s = Math.min(s, stability);
  } else {
    const hardPenalty = rating === 2 ? W[15] : 1.0;
    const easyBonus = rating === 4 ? W[16] : 1.0;
    s = stability * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(stability, -W[9])
        * (Math.exp(W[10] * (1 - r)) - 1) * hardPenalty * easyBonus);
  }
  return [Math.max(s, 0.01), d];
}

function intervalDays(stability) {
  const ivl = stability / FACTOR * (Math.pow(REQUEST_RETENTION, 1 / DECAY) - 1);
  return Math.max(1, pyRound(ivl));
}

// Apply one review to a card's state (or null for a never-reviewed card).
// Mirrors cmd_review in fsrs.py; returns the new state object for reviews.json.
function applyReview(state, grade, dateIso) {
  const rating = { 0: 1, 1: 2, 2: 3, 3: 4 }[grade];
  let stability, difficulty;
  if (state == null) {
    [stability, difficulty] = initState(rating);
  } else {
    const last = state.history[state.history.length - 1].date;
    const elapsed = Math.max(daysBetween(last, dateIso), 0);
    [stability, difficulty] = nextState(state.stability, state.difficulty, elapsed, rating);
  }
  const ivl = grade === 0 ? 0 : intervalDays(stability);
  return {
    stability: pyRound(stability, 4),
    difficulty: pyRound(difficulty, 4),
    due: addDays(dateIso, ivl),
    history: [...(state ? state.history : []), { date: dateIso, grade }],
  };
}

export { applyReview, retrievability, intervalDays, todayIso, daysBetween, addDays };

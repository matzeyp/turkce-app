// Scaffolded acquisition — pure helpers (no DOM, no storage). See the data
// repo's BUILD.md §10. New and weak cards climb a ladder: intro (study, no
// grade) → multiple choice (vocab only, correct = Hard) → free recall with
// optional graded hints. The rung is derived from review history, never
// stored, so the deck schema is untouched and the ladder retires itself.

// a card leaves the multiple-choice rung after this many successes in a row
const MC_RUNG_SUCCESSES = 2;
// a production card is served only once its recognition sibling is off the rung
const GATE_SUCCESSES = MC_RUNG_SUCCESSES;

const isVocab = (c) => c.type === "vocab_recognition" || c.type === "vocab_production";

// successful reviews (grade ≥ 1) since the last lapse (grade 0); a never-
// reviewed card counts 0. Detail-only entries carry a normal grade, so
// multiple-choice passes count like any other success.
function successesSinceLapse(state) {
  if (!state) return 0;
  let n = 0;
  for (const h of state.history) n = h.grade === 0 ? 0 : n + 1;
  return n;
}

// which retrieval format a card gets right now
function rung(card, state) {
  if (isVocab(card) && successesSinceLapse(state) < MC_RUNG_SUCCESSES) return "mc";
  return "recall";
}

const siblingRecogId = (card) =>
  card.type === "vocab_production" ? card.id.replace(/_prod$/, "_recog") : null;

// recognition-before-production: hide a production card while the same
// word's recognition card has not left the multiple-choice rung
function isGated(card, reviews, deckIds) {
  const sib = siblingRecogId(card);
  if (!sib || !deckIds.has(sib)) return false;
  return successesSinceLapse(reviews[sib]) < GATE_SUCCESSES;
}

// cards whose first-ever review happened today (daily new-card budget)
function introducedOn(reviews, dateIso) {
  let n = 0;
  for (const st of Object.values(reviews)) if (st.history[0]?.date === dateIso) n++;
  return n;
}

// coarse part-of-speech proxy so distractors look like the answer: verbs are
// "to …" glosses (recognition) or -mek/-mak citation forms (production)
function verbLike(card) {
  if (card.type === "vocab_recognition") return /^to\b/i.test(card.back.trim());
  const head = card.back.trim().split(/[\s(,;]/)[0];
  return /(mek|mak)$/.test(head);
}

function shuffleWith(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 4 options: the card's own back + 3 distractor backs of the same card type
// and part-of-speech class, preferring words the learner has already reviewed
// (unreviewed backs would be learned as lures). Falls back to any same-type
// card when the class runs dry. Returns [{text, correct}] in shuffled order.
function buildOptions(card, deck, reviews, rng = Math.random, count = 4) {
  const seen = new Set([card.back.trim()]);
  const pool = deck.filter((c) => c.type === card.type && c.id !== card.id);
  const pick = (cands, want, out) => {
    for (const c of shuffleWith([...cands], rng)) {
      if (out.length >= want) break;
      const t = c.back.trim();
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  };
  const cls = verbLike(card);
  const same = pool.filter((c) => verbLike(c) === cls);
  const out = [];
  pick(same.filter((c) => reviews[c.id]), count - 1, out);
  pick(same, count - 1, out);
  pick(pool, count - 1, out);
  const options = out.map((text) => ({ text, correct: false }));
  options.push({ text: card.back.trim(), correct: true });
  return shuffleWith(options, rng);
}

// parse the `Seen in:` / `First seen:` block of a vocab explanation into
// [{line, title}] — the anchor lines the learner already knows from the source
function contextLines(explanation) {
  const m = /(?:Seen in:|First seen:)\s*([\s\S]*)$/.exec(explanation || "");
  if (!m) return [];
  const out = [];
  for (const raw of m[1].split("\n")) {
    const mm = /^"(.+)"\s+\((.+)\)\s*$/.exec(raw.trim());
    if (mm) out.push({ line: mm[1], title: mm[2] });
  }
  return out;
}

const trLower = (s) => s.replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase();

// citation form of a production card's answer: first token of the back
function lemmaOf(productionBack) {
  return productionBack.trim().split(/[\s(,;/]/)[0];
}

// blank out the target word in a context line (any inflected form: tokens
// sharing the lemma's stem). Returns null when nothing matched, so the caller
// can fall back to a weaker hint instead of leaking the answer.
function maskWord(line, lemma) {
  const l = trLower(lemma);
  const stem = /(mek|mak)$/.test(l) ? l.slice(0, -3) : l;
  let hit = false;
  const masked = line.replace(/[\p{L}\p{M}]+/gu, (tok) => {
    const t = trLower(tok);
    const ok = t.startsWith(stem) && (stem.length >= 3 || t.length <= stem.length + 2);
    if (!ok) return tok;
    hit = true;
    return "____";
  });
  return hit ? masked : null;
}

// first-letter cue: initial letter of the answer's first word, then a dot per
// remaining letter of that word ("g····" for gitmek)
function firstLetterHint(back) {
  const w = back.trim().split(/[\s(,;/]/)[0] || "";
  return w.slice(0, 1) + "·".repeat(Math.max(w.length - 1, 0));
}

// hints available for a card, strongest-later: recognition (Turkish shown)
// gets the source line first since it does not leak the English; production
// gets the first letter first and the masked line second; other cards get
// letter cues only. Each is {label, text}.
function hintsFor(card) {
  const hints = [];
  if (card.type === "vocab_recognition") {
    const ctx = contextLines(card.explanation).slice(0, 2);
    if (ctx.length) hints.push({ label: "context", text: ctx.map((c) => `"${c.line}"`).join("\n") });
    hints.push({ label: "first letter", text: firstLetterHint(card.back) });
  } else if (card.type === "vocab_production") {
    hints.push({ label: "first letter", text: firstLetterHint(card.back) });
    const lemma = lemmaOf(card.back);
    const ctx = contextLines(card.explanation).map((c) => maskWord(c.line, lemma)).filter(Boolean);
    if (ctx.length) hints.push({ label: "context", text: `"${ctx[0]}"` });
  } else {
    hints.push({ label: "first letter", text: firstLetterHint(card.back) });
    const w = card.back.trim().split(/\s/)[0];
    if (w.length > 3) hints.push({ label: "first letters", text: w.slice(0, 3) + "·".repeat(w.length - 3) });
  }
  return hints.slice(0, 2);
}

// highest grade allowed after n hints: 1 hint → Good at most, 2 → Hard at most
const gradeCap = (hintsUsed) => Math.max(3 - hintsUsed, 1);

export {
  MC_RUNG_SUCCESSES, GATE_SUCCESSES, successesSinceLapse, rung, isGated, introducedOn,
  buildOptions, contextLines, maskWord, firstLetterHint, hintsFor, gradeCap, verbLike, lemmaOf,
};

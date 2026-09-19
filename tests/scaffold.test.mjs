// Unit tests for scaffold.js (pure ladder logic). Run: node tests/scaffold.test.mjs
import assert from "node:assert/strict";
import {
  successesSinceLapse, rung, isGated, introducedOn, buildOptions, contextLines,
  maskWord, firstLetterHint, hintsFor, gradeCap, verbLike, lemmaOf,
} from "../scaffold.js";

const st = (...grades) => ({
  stability: 1, difficulty: 5, due: "2026-01-01",
  history: grades.map((g, i) => ({ date: `2026-01-0${i + 1}`, grade: g })),
});

// successes since lapse
assert.equal(successesSinceLapse(null), 0);
assert.equal(successesSinceLapse(st(1)), 1);
assert.equal(successesSinceLapse(st(2, 3)), 2);
assert.equal(successesSinceLapse(st(2, 3, 0)), 0);
assert.equal(successesSinceLapse(st(0, 1)), 1);

// rung
const recog = { id: "card_v_gitmek_recog", type: "vocab_recognition", front: "gitmek", back: "to go",
  explanation: 'Seen in:\n"Gidiyorum gündüz gece" (Uzun İnce Bir Yoldayım)\n"Gitmek istiyorum." (Sentence Builder)' };
const prod = { id: "card_v_gitmek_prod", type: "vocab_production", front: "to go", back: "gitmek",
  explanation: recog.explanation };
const morph = { id: "card_v_gitmek_break", type: "morph_breakdown", front: "gidiyorum", back: "gid-iyor-um = go-PROG-1SG" };
assert.equal(rung(recog, null), "mc");
assert.equal(rung(recog, st(1)), "mc");
assert.equal(rung(recog, st(1, 2)), "recall");
assert.equal(rung(recog, st(1, 2, 0)), "mc", "a lapse drops the card back to the rung");
assert.equal(rung(morph, null), "recall", "non-vocab cards never get multiple choice");

// gating
const ids = new Set([recog.id, prod.id, morph.id]);
assert.equal(isGated(prod, {}, ids), true, "no recognition history → gated");
assert.equal(isGated(prod, { [recog.id]: st(1) }, ids), true);
assert.equal(isGated(prod, { [recog.id]: st(1, 2) }, ids), false);
assert.equal(isGated(recog, {}, ids), false);
assert.equal(isGated(prod, {}, new Set([prod.id])), false, "no sibling in deck → not gated");

// daily budget
assert.equal(introducedOn({ a: st(1), b: st(2, 2) }, "2026-01-01"), 2);
assert.equal(introducedOn({ a: st(1), b: st(2, 2) }, "2026-01-02"), 0);

// verb-likeness proxy
assert.equal(verbLike(recog), true);
assert.equal(verbLike({ type: "vocab_recognition", back: "night" }), false);
assert.equal(verbLike(prod), true);
assert.equal(verbLike({ type: "vocab_production", back: "boşvermek (imperative: boşver)" }), true);
assert.equal(verbLike({ type: "vocab_production", back: "gece" }), false);
assert.equal(lemmaOf("boşvermek (imperative: boşver)"), "boşvermek");

// options: 4 distinct, exactly one correct, same class preferred, reviewed first
const deck = [recog, prod, morph,
  { id: "card_v_gelmek_recog", type: "vocab_recognition", back: "to come" },
  { id: "card_v_bilmek_recog", type: "vocab_recognition", back: "to know (a fact)" },
  { id: "card_v_gormek_recog", type: "vocab_recognition", back: "to see" },
  { id: "card_v_yurumek_recog", type: "vocab_recognition", back: "to walk" },
  { id: "card_v_gece_recog", type: "vocab_recognition", back: "night" },
  { id: "card_v_dup_recog", type: "vocab_recognition", back: "to go" },
];
let seed = 1;
const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const reviewed = { card_v_gelmek_recog: st(2), card_v_bilmek_recog: st(2), card_v_gormek_recog: st(2) };
for (let i = 0; i < 20; i++) {
  const opts = buildOptions(recog, deck, reviewed, rng);
  assert.equal(opts.length, 4);
  assert.equal(opts.filter((o) => o.correct).length, 1);
  assert.equal(new Set(opts.map((o) => o.text)).size, 4, "no duplicate texts (dup 'to go' excluded)");
  const texts = opts.map((o) => o.text);
  assert.ok(!texts.includes("night"), "same-class distractors when enough exist");
  for (const t of ["to come", "to know (a fact)", "to see"]) assert.ok(texts.includes(t), "reviewed first");
}
// class runs dry → fill from any same-type card, never from another type
const small = [recog, morph, { id: "x", type: "vocab_recognition", back: "night" },
  { id: "y", type: "vocab_recognition", back: "road" }, { id: "z", type: "vocab_production", back: "gece" }];
const o2 = buildOptions(recog, small, {}, rng);
assert.equal(o2.length, 3);
assert.ok(!o2.some((o) => o.text === "gece"));

// context lines
assert.deepEqual(contextLines(recog.explanation), [
  { line: "Gidiyorum gündüz gece", title: "Uzun İnce Bir Yoldayım" },
  { line: "Gitmek istiyorum.", title: "Sentence Builder" }]);
assert.deepEqual(contextLines('…notes…\nFirst seen: "Uzun ince bir yoldayım" (Uzun İnce Bir Yoldayım, Âşık Veysel)'),
  [{ line: "Uzun ince bir yoldayım", title: "Uzun İnce Bir Yoldayım, Âşık Veysel" }]);
assert.deepEqual(contextLines("no block here"), []);

// masking: inflected forms, Turkish casing, short stems
assert.equal(maskWord("Gidiyorum gündüz gece", "gitmek"), null,
  "gid- ≠ git- stem: softened forms are not matched, caller skips the line");
assert.equal(maskWord("Gitmek istiyorum.", "gitmek"), "____ istiyorum.");
assert.equal(maskWord("Uzun ince bir yoldayım", "yol"), "Uzun ince bir ____");
assert.equal(maskWord("İnce bir yol", "ince"), "____ bir yol");
assert.equal(maskWord("Ne oldu bir anda", "ne"), "____ oldu bir anda", "2-letter stem: whole-word-ish only");
assert.equal(maskWord("Nerede kaldın", "ne"), null, "2-letter stem does not swallow 'nerede'");
assert.equal(maskWord("Gündüz gece", "gitmek"), null);

// hints
assert.equal(firstLetterHint("gitmek"), "g·····");
assert.equal(firstLetterHint("to go"), "t·");
const hr = hintsFor(recog);
assert.equal(hr.length, 2);
assert.equal(hr[0].label, "context");
assert.ok(hr[0].text.includes("Gidiyorum gündüz gece"));
assert.equal(hr[1].text, "t·");
const hp = hintsFor(prod);
assert.equal(hp[0].text, "g·····");
assert.equal(hp[1].label, "context");
assert.equal(hp[1].text, '"____ istiyorum."', "production context hint never shows the answer");
const hm = hintsFor(morph);
assert.equal(hm[0].text, "g··········");
assert.equal(hm[1].text, "gid········");
assert.equal(hintsFor({ type: "vocab_production", back: "gece", explanation: "" }).length, 1);

// grade caps
assert.equal(gradeCap(0), 3);
assert.equal(gradeCap(1), 2);
assert.equal(gradeCap(2), 1);

console.log("scaffold tests OK");

// Join-time phonology for the sentence builder — the ONLY Turkish knowledge
// hardcoded in this app (BUILD.md §9 decision 2: generic boundary effects with
// zero decision content). Everything lexical (vakt-, gid-, softening stems)
// arrives pre-supplied in the card data; wheel choices carry harmony/allomorphs.

const VOWELS = "aeıioöuü";
const endsVowel = (w) => VOWELS.includes(w.slice(-1));

// suffix-final k that softens intervocalically (gelecek+im → geleceğim)
const SOFT_K_SUFFIX = new Set(["m_fut", "m_nmlz_acak", "m_nmlz_dik", "m_inf"]);
// ek-fiil clitics take the y-buffer after vowels even before a consonant
// (hasta+dı → hastaydı: the y replaces the i of archaic idi)
const EKFIIL_Y = new Set(["m_cop_pst", "m_cop_evid", "m_cop_cond", "m_cop_ken"]);
// pronominal -n- after a 3rd-person possessive, before any case (evi+de → evinde)
const POSS3 = new Set(["m_poss_3sg", "m_poss_3pl"]);

// stem: from lemma_bank ("konuş-", "hasta", "mI"); picks: [{morpheme_id, surface}]
// slotOf: morpheme_id -> slot category (from morphemes.json)
export function joinWord(stem, picks, slotOf) {
  let w = stem === "mI" ? "" : stem.replace(/-$/, "");
  let prev = null;
  for (const p of picks) {
    const s = p.surface;
    const sVowel = VOWELS.includes(s[0]);
    if (w) {
      if (p.morpheme_id === "m_prog" && endsVowel(w)) {
        w = w.slice(0, -1);                       // iste+iyor→istiyor, tanı+ıyor→tanıyor
      } else if (prev && POSS3.has(prev) && slotOf(p.morpheme_id) === "noun_case") {
        w += "n";                                 // arabası+da→arabasında
      } else if (EKFIIL_Y.has(p.morpheme_id) && endsVowel(w)) {
        w += "y";                                 // hasta+dı→hastaydı, öğrenci+ken→öğrenciyken
      } else if (sVowel && endsVowel(w)) {
        w += "y";                                 // gele+im→geleyim, kapı+a→kapıya
      } else if (sVowel && w.slice(-1) === "k" && prev && SOFT_K_SUFFIX.has(prev)) {
        w = w.slice(0, -1) + "ğ";                 // sevdik+im→sevdiğim
      }
    }
    w += s;
    prev = p.morpheme_id;
  }
  return w;
}

// naive concatenation, for showing WHICH rule fired in the join animation
export function naiveJoin(stem, picks) {
  const base = stem === "mI" ? "" : stem.replace(/-$/, "");
  return base + picks.map((p) => p.surface).join("");
}

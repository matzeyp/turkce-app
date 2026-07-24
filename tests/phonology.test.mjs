// Join-time phonology tests — every boundary rule the builder auto-applies.
// slotOf is stubbed structurally (ids/slots mirror data/morphemes.json in the
// data repo; no learning content lives here).
import test from "node:test";
import assert from "node:assert/strict";
import { joinWord, naiveJoin } from "../phonology.js";

const SLOTS = {
  m_acc: "noun_case", m_dat: "noun_case", m_loc: "noun_case", m_abl: "noun_case",
  m_gen: "noun_case", m_ins: "noun_case",
};
const slotOf = (id) => SLOTS[id];
const j = (stem, ...picks) =>
  joinWord(stem, picks.map(([morpheme_id, surface]) => ({ morpheme_id, surface })), slotOf);

test("suffix-final k softens intervocalically", () => {
  assert.equal(j("gel-", ["m_fut", "ecek"], ["m_pers_cop_1sg", "im"]), "geleceğim");
  assert.equal(j("sev-", ["m_nmlz_dik", "dik"], ["m_poss_1sg", "im"]), "sevdiğim");
});

test("k stays before a consonant-initial suffix", () => {
  assert.equal(j("gör-", ["m_nmlz_dik", "dük"], ["m_poss_3pl", "leri"]), "gördükleri");
});

test("general y-buffer between vowels", () => {
  assert.equal(j("gel-", ["m_opt", "e"], ["m_pers_cop_1sg", "im"]), "geleyim");
  assert.equal(j("yol", ["m_loc", "da"], ["m_pers_cop_1sg", "ım"]), "yoldayım");
});

test("ek-fiil clitics take y after a vowel even before a consonant", () => {
  assert.equal(j("hasta", ["m_cop_pst", "dı"], ["m_pers_poss_1sg", "m"]), "hastaydım");
  assert.equal(j("öğrenci", ["m_cop_ken", "ken"]), "öğrenciyken");
  assert.equal(j("gel-", ["m_pst", "di"], ["m_cop_cond", "se"]), "geldiyse");
  assert.equal(j("var", ["m_cop_cond", "sa"]), "varsa");
});

test("-Iyor drops a stem-final vowel", () => {
  assert.equal(j("iste-", ["m_prog", "iyor"], ["m_pers_cop_1sg", "um"]), "istiyorum");
  assert.equal(j("tanı-", ["m_prog", "ıyor"]), "tanıyor");
  assert.equal(j("bekle-", ["m_prog", "iyor"]), "bekliyor");
});

test("pronominal n after 3rd-person possessive, before any case", () => {
  assert.equal(j("araba", ["m_poss_3sg", "sı"], ["m_loc", "da"]), "arabasında");
  assert.equal(j("ev", ["m_poss_3sg", "i"], ["m_acc", "i"]), "evini");
});

test("plain concatenation everywhere else", () => {
  assert.equal(j("git-", ["m_inf", "mek"]), "gitmek");
  assert.equal(j("vakt-", ["m_poss_2sg", "in"]), "vaktin");
  assert.equal(j("git-", ["m_nmlz_ma", "me"], ["m_poss_2sg", "n"], ["m_acc", "i"]), "gitmeni");
  assert.equal(j("konuş-", ["m_opt", "a"], ["m_pers_opt_1pl", "lım"]), "konuşalım");
  assert.equal(j("kes-", ["m_caus", "tir"], ["m_pst", "di"], ["m_pers_poss_1sg", "m"]), "kestirdim");
});

test("mI is its own word with an empty stem", () => {
  assert.equal(j("mI", ["m_q", "mi"], ["m_pers_cop_2sg", "sin"]), "misin");
});

test("naiveJoin shows what the rules changed", () => {
  assert.equal(naiveJoin("gel-", [{ morpheme_id: "m_fut", surface: "ecek" },
    { morpheme_id: "m_pers_cop_1sg", surface: "im" }]), "gelecekim");
});

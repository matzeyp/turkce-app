// Sentence-builder tab: assemble Turkish sentences from lemma tiles + two-wheel
// suffix picker (data repo BUILD.md §9). The app stays dumb: cards carry the
// targets and distractors, morphemes.json carries the tile inventory and slot
// rules, phonology.js applies the boundary effects. Auto-grades 0-3 and logs
// wheel-1 vs wheel-2 error counts in the review's detail field.
import { joinWord, naiveJoin } from "./phonology.js";

let ctx = null;      // { getDeck, getReviews, getMorphemes, label, record, onSessionEnd, getSettings }
let morphById = {};
let rules = null;

let s = null;        // active session: { queue, done, reviewed }
let play = null;     // active card state

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const slotOf = (mid) => morphById[mid]?.slot;
const isBuildCard = (c) => c.type === "sentence_build";

// Turkish-aware normalisation for answer comparison
const norm = (t) => t.toLocaleLowerCase("tr").replace(/[.!?…]+$/u, "").replace(/\s+/g, " ").trim();

function loadInventory() {
  const inv = ctx.getMorphemes();
  if (!inv) return false;
  morphById = Object.fromEntries(inv.morphemes.map((m) => [m.id, m]));
  rules = inv.slot_rules;
  return true;
}

// ---------------------------------------------------------------- queues

function builderCards() { return ctx.getDeck().filter(isBuildCard); }

function dueBuilderQueue() {
  const reviews = ctx.getReviews();
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const c of builderCards()) {
    const st = reviews[c.id];
    if (!st) rows.push({ c, sort: "1~new" });
    else if (st.due <= today) rows.push({ c, sort: "0~" + st.due });
  }
  rows.sort((a, b) => a.sort.localeCompare(b.sort));
  return rows.map((r) => r.c);
}

// ---------------------------------------------------------------- home

export function renderBuilderHome() {
  const el = $("builder-lists");
  $("builder-home").hidden = false;
  $("builder-play").hidden = true;
  if (!loadInventory() || builderCards().length === 0) {
    el.innerHTML = "<p>no builder cards cached yet — sync in settings.</p>";
    return;
  }
  const due = dueBuilderQueue();
  const all = builderCards();
  el.innerHTML = `
    ${item("due + new", due.length, "due")}
    ${item("practice all", all.length, "all")}`;
  el.querySelectorAll("[data-sb]").forEach((btn) =>
    btn.addEventListener("click", () => startBuilderSession(btn.dataset.sb)));
  function item(text, count, mode) {
    return `<button class="deck-item" data-sb="${mode}" ${count === 0 ? "disabled" : ""}>
      <span>${esc(text)}</span><span class="count">${count}</span></button>`;
  }
}

function startBuilderSession(mode) {
  const queue = mode === "all" ? shuffle([...builderCards()]) : dueBuilderQueue();
  s = { queue, reviewed: new Set() };
  $("builder-home").hidden = true;
  $("builder-play").hidden = false;
  nextCard();
}

export function endBuilderSession() {
  if (s && s.reviewed.size > 0) ctx.onSessionEnd();
  s = null;
  play = null;
  renderBuilderHome();
}

function nextCard() {
  const card = s.queue[0];
  $("builder-result").hidden = true;
  $("builder-done").hidden = true;
  if (!card) {
    $("builder-done").hidden = false;
    $("builder-summary").textContent =
      s.reviewed.size === 0 ? "nothing due 🎉" : `session done — ${s.reviewed.size} sentences built`;
    ["builder-prompt", "builder-sentence", "builder-bank", "builder-feedback", "builder-progress"]
      .forEach((id) => { $(id).textContent = ""; });
    $("builder-actions").hidden = true;
    if (s.reviewed.size > 0) ctx.onSessionEnd();
    return;
  }
  const decisions = card.target_words.reduce((n, t) => n + t.suffixes.length, 0);
  play = {
    card,
    words: [],                       // placed words: { bankIdx, stem, picks[], state }
    used: new Set(),                 // bank indices already placed
    retries: 0, w1: 0, w2: 0, order: 0,
    decisions,
    t0: Date.now(),
    sheet: null,
  };
  $("builder-actions").hidden = false;
  $("builder-feedback").textContent = "";
  $("builder-progress").textContent = `${s.queue.length} left · sentence build`;
  $("builder-prompt").textContent = card.front;
  renderPlay();
}

// ---------------------------------------------------------------- play canvas

function targetFor(word) {
  return play.card.target_words.find((t) => t.stem === word.stem);
}

function wordText(word) {
  return joinWord(word.stem, word.picks, slotOf) || word.stem;
}

function renderPlay() {
  const bankEl = $("builder-bank");
  bankEl.innerHTML = play.card.lemma_bank.map((b, i) =>
    `<button class="bank-tile" data-bank="${i}" ${play.used.has(i) ? "disabled" : ""}>
       <span class="tile-lemma">${esc(b.lemma)}</span>
       <span class="tile-gloss" lang="en">${esc(b.gloss)}</span></button>`).join("");
  bankEl.querySelectorAll("[data-bank]").forEach((btn) =>
    btn.addEventListener("click", () => placeWord(Number(btn.dataset.bank))));

  const sentEl = $("builder-sentence");
  sentEl.innerHTML = play.words.length === 0
    ? `<span class="sb-hint">tap words below in order — tap a placed word to add suffixes</span>`
    : play.words.map((w, i) => `
      <span class="sb-word" data-word="${i}">
        <span class="sb-word-text">${esc(wordText(w))}</span>
        <span class="sb-chips">${w.picks.map((p, j) =>
          `<button class="sb-chip" data-word="${i}" data-chip="${j}"
             title="remove">+${esc(morphById[p.morpheme_id]?.form ?? p.surface)}</button>`).join("")}</span>
        <button class="sb-word-x" data-unplace="${i}" title="remove word">×</button>
      </span>`).join(" ");
  sentEl.querySelectorAll(".sb-word-text").forEach((el) =>
    el.addEventListener("click", (e) => {
      const i = Number(e.target.closest(".sb-word").dataset.word);
      openSheet(i);
    }));
  sentEl.querySelectorAll(".sb-chip").forEach((el) =>
    el.addEventListener("click", () => {
      // a chip depends on what was stacked after it: removing chip j drops j and everything later
      const w = play.words[Number(el.dataset.word)];
      w.picks = w.picks.slice(0, Number(el.dataset.chip));
      renderPlay();
    }));
  sentEl.querySelectorAll("[data-unplace]").forEach((el) =>
    el.addEventListener("click", () => {
      const i = Number(el.dataset.unplace);
      play.used.delete(play.words[i].bankIdx);
      play.words.splice(i, 1);
      renderPlay();
    }));
}

function placeWord(bankIdx) {
  const bank = play.card.lemma_bank[bankIdx];
  play.used.add(bankIdx);
  play.words.push({ bankIdx, stem: bank.stem, picks: [] });
  renderPlay();
  const target = play.card.target_words.find((t) => t.stem === bank.stem);
  if (target && target.suffixes.length > 0) openSheet(play.words.length - 1);
}

// ---------------------------------------------------------------- wheel sheet

function personSetFor(word) {
  for (let i = word.picks.length - 1; i >= 0; i--) {
    const m = morphById[word.picks[i].morpheme_id];
    if (m && m.person_set) return m.person_set;
  }
  return "cop";
}

function morphIdsForCategory(cat, word) {
  const all = Object.values(morphById);
  if (cat === "person") return rules.person_sets[personSetFor(word)] ?? [];
  if (cat === "person_cop") return all.filter((m) => m.slot === "person_cop" || m.slot === "person_both").map((m) => m.id);
  if (cat === "person_imp") return rules.person_sets.imp;
  return all.filter((m) => m.slot === cat).map((m) => m.id);
}

// wheel-1 list: everything legal in the current slot would overflow a phone
// screen (a bare verb legally takes ~30 morphemes), so offer the expected
// morpheme, its whole category (the real decision space), then fill from the
// other legal categories, capped — scrambled every render so position carries
// no memory.
function wheel1Options(word) {
  let state = word.stem.endsWith("-") ? "V0" : "N0";
  for (const p of word.picks) {
    const trans = rules.states[state] ?? {};
    const m = morphById[p.morpheme_id];
    const cat = m && m.slot.startsWith("person") ? "person" : m?.slot;
    state = trans[cat] ?? trans[m?.slot] ?? state;
  }
  const cats = Object.keys(rules.states[state] ?? {});
  const legal = [...new Set(cats.flatMap((c) => morphIdsForCategory(c, word)))];
  const target = targetFor(word);
  const expected = target?.suffixes[word.picks.length];
  if (!expected) return shuffle(legal).slice(0, 10);
  const expCat = morphById[expected.morpheme_id]?.slot;
  const sameCat = legal.filter((id) => slotOf(id) === expCat && id !== expected.morpheme_id);
  const rest = legal.filter((id) => slotOf(id) !== expCat);
  const pickd = [expected.morpheme_id, ...shuffle(sameCat), ...shuffle(rest)].slice(0, 10);
  if (!pickd.includes(expected.morpheme_id)) pickd[0] = expected.morpheme_id;
  return shuffle(pickd);
}

function openSheet(wordIdx) {
  const word = play.words[wordIdx];
  play.sheet = { wordIdx, sel1: null, sel2: null };
  $("builder-sheet").hidden = false;
  $("sheet-info").hidden = true;
  $("btn-sheet-confirm").disabled = true;
  const delayOn = ctx.getSettings().builderDelay !== false;
  $("sheet-delay").hidden = !delayOn;
  $("sheet-wheels").classList.toggle("veiled", delayOn);
  if (delayOn) setTimeout(() => {
    $("sheet-delay").hidden = true;
    $("sheet-wheels").classList.remove("veiled");
  }, 1200);
  renderWheel1(wheel1Options(word));
  renderWheel2([]);
}

function renderWheel1(ids) {
  $("sheet-wheel1").innerHTML = ids.map((id) => {
    const m = morphById[id];
    return `<li><button class="wheel-opt" data-m="${id}">
      <span lang="tr">${esc(m.form)}</span> <span class="wheel-tag">${esc(m.tag)}</span></button>
      <button class="wheel-info" data-info="${id}" aria-label="info">ⓘ</button></li>`;
  }).join("");
  $("sheet-wheel1").querySelectorAll(".wheel-opt").forEach((btn) =>
    btn.addEventListener("click", () => {
      play.sheet.sel1 = btn.dataset.m;
      play.sheet.sel2 = null;
      $("btn-sheet-confirm").disabled = true;
      $("sheet-wheel1").querySelectorAll(".wheel-opt").forEach((b) =>
        b.classList.toggle("sel", b === btn));
      renderWheel2(shuffle([...morphById[btn.dataset.m].realisations]));
    }));
  $("sheet-wheel1").querySelectorAll(".wheel-info").forEach((btn) =>
    btn.addEventListener("click", () => showInfo(btn.dataset.info)));
}

function renderWheel2(realisations) {
  $("sheet-wheel2").innerHTML = realisations.map((r) =>
    `<li><button class="wheel-opt" data-r="${esc(r)}" lang="tr">${esc(r)}</button></li>`).join("");
  $("sheet-wheel2").querySelectorAll(".wheel-opt").forEach((btn) =>
    btn.addEventListener("click", () => {
      play.sheet.sel2 = btn.dataset.r;
      $("sheet-wheel2").querySelectorAll(".wheel-opt").forEach((b) =>
        b.classList.toggle("sel", b === btn));
      $("btn-sheet-confirm").disabled = false;
    }));
}

function showInfo(mid) {
  const m = morphById[mid];
  const el = $("sheet-info");
  el.innerHTML = `<strong lang="tr">${esc(m.form)}</strong> ${esc(m.tag)} — ${esc(m.gloss)}
    <br><span lang="tr">${esc(m.example)}</span>
    <br><small>${esc(ctx.label(m.concept_id))}</small>`;
  el.hidden = false;
}

function confirmSheet() {
  const { wordIdx, sel1, sel2 } = play.sheet;
  if (!sel1 || !sel2) return;
  const word = play.words[wordIdx];
  // score the pick against the target before it lands (self-corrections still count)
  const expected = targetFor(word)?.suffixes[word.picks.length];
  if (expected) {
    if (sel1 !== expected.morpheme_id) play.w1++;
    else if (sel2 !== expected.surface) play.w2++;
  }
  const before = wordText(word);
  word.picks.push({ morpheme_id: sel1, surface: sel2 });
  closeSheet();
  renderPlay();
  // join animation: when a boundary rule fired, show it
  const after = wordText(word);
  const naive = naiveJoin(word.stem, word.picks);
  if (after !== naive) {
    $("builder-feedback").textContent = `${before} + ${sel2} → ${after}`;
    const el = $("builder-sentence").querySelector(`[data-word="${wordIdx}"] .sb-word-text`);
    if (el) el.classList.add("sb-flash");
    setTimeout(() => {
      if ($("builder-feedback").textContent.startsWith(before)) $("builder-feedback").textContent = "";
    }, 2500);
  }
}

function closeSheet() {
  play.sheet = null;
  $("builder-sheet").hidden = true;
}

// ---------------------------------------------------------------- grading

function builtSentence() {
  return play.words.map(wordText).join(" ");
}

function submit() {
  if (!play || play.words.length === 0) return;
  const built = builtSentence();
  const ok = play.card.accepted.some((a) => norm(a) === norm(built));
  if (ok) {
    const fast = (Date.now() - play.t0) / 1000 <= 15 + 12 * play.decisions;
    const clean = play.w1 + play.w2 === 0 && play.retries === 0;
    finish(play.retries > 0 ? 1 : clean && fast ? 3 : 2);
    return;
  }
  play.retries++;
  // same words, wrong order → order error (vs. wrong morphology)
  const key = (t) => norm(t).split(" ").sort().join("|");
  if (play.card.accepted.some((a) => key(a) === key(built))) {
    play.order++;
    $("builder-feedback").textContent = "right words — check the order";
  } else {
    $("builder-feedback").textContent = "not quite — check the suffixes and try again";
  }
}

function reveal() { if (play) finish(0); }

function finish(grade) {
  const detail = {
    wheel1_errors: play.w1, wheel2_errors: play.w2,
    order_errors: play.order, retries: play.retries,
  };
  ctx.record(play.card.id, grade, detail);
  s.reviewed.add(play.card.id);
  s.queue.shift();
  if (grade === 0) s.queue.push(play.card); // blackout repeats today, end of queue
  const names = ["fail — again today", "hard", "good", "easy"];
  $("builder-result").hidden = false;
  $("sb-grade").textContent = `${grade} · ${names[grade]}`;
  $("sb-answer").textContent = play.card.back;
  $("sb-explanation").textContent = play.card.explanation ?? "";
  $("builder-actions").hidden = true;
}

// ---------------------------------------------------------------- wiring

export function initBuilder(context) {
  ctx = context;
  $("btn-sb-submit").addEventListener("click", submit);
  $("btn-sb-reveal").addEventListener("click", reveal);
  $("btn-sb-next").addEventListener("click", () => { $("builder-actions").hidden = false; nextCard(); });
  $("btn-sb-back").addEventListener("click", endBuilderSession);
  $("btn-exit-builder").addEventListener("click", endBuilderSession);
  $("btn-sheet-confirm").addEventListener("click", confirmSheet);
  $("btn-sheet-cancel").addEventListener("click", closeSheet);
  $("sheet-backdrop").addEventListener("click", closeSheet);
}

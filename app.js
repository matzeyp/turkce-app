// türkçe review app — deliberately dumb practice client.
// Reads data/deck.json, writes ONLY data/reviews.json, both in the private
// data repo via the GitHub contents API. All intelligence lives in the data
// repo's Claude Code layer; this app shows cards, records grades, runs FSRS.
import { applyReview, retrievability, daysBetween, todayIso } from "./fsrs.js";
import { initBuilder, renderBuilderHome, endBuilderSession } from "./builder.js";
import { rung, isGated, introducedOn, buildOptions, hintsFor, gradeCap } from "./scaffold.js";

const LS = {
  settings: "turkce.settings",
  deck: "turkce.deck",
  labels: "turkce.labels",      // id -> display name (source titles, concept names)
  morphemes: "turkce.morphemes", // sentence_build tile inventory + slot rules
  base: "turkce.reviewsBase",   // last-synced remote reviews.json + its blob sha
  pending: "turkce.pending",    // offline-safe grade log, replayed onto base
  lastSync: "turkce.lastSync",
};

const load = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; }
  catch { return fallback; }
};
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let settings = load(LS.settings, { owner: "matzeyp", repo: "turkce", pat: "" });
if (!settings.direction) settings.direction = "mixed";
if (settings.builderDelay === undefined) settings.builderDelay = true;
// scaffolding (BUILD.md §10): intro step + multiple-choice rung + hints +
// recognition-before-production gating; newPerDay caps first-ever reviews (0 = no cap)
if (settings.scaffold === undefined) settings.scaffold = true;
if (settings.newPerDay === undefined) settings.newPerDay = 10;
let deck = load(LS.deck, []);
let labels = load(LS.labels, {});
const label = (id) => labels[id] ?? id;
let base = load(LS.base, { data: {}, sha: null });
let pending = load(LS.pending, []);

// ---------------------------------------------------------------- FSRS state

// current reviews state = last-synced remote state + pending grades replayed
function effectiveReviews() {
  const reviews = structuredClone(base.data);
  for (const p of pending) {
    reviews[p.card_id] = applyReview(reviews[p.card_id] ?? null, p.grade, p.date, p.detail);
  }
  return reviews;
}

const isVocab = (c) => c.type === "vocab_recognition" || c.type === "vocab_production";
// sentence_build cards live in their own tab; the review flow never serves them
const isBuilder = (c) => c.type === "sentence_build";

// source membership: a vocab card belongs to every source its word was sighted
// in (the word really occurs there), but a concept card (breakdown/grammar)
// only to its origin — source_ids is append-only, so [0] is where the card's
// content (its example line, its form) comes from. Later sightings of the
// concept elsewhere would otherwise drag e.g. Veysel lines into Hoca.
const inSource = (c, source) =>
  isVocab(c) ? c.source_ids.includes(source) : c.source_ids[0] === source;

function allVocabCards(source) {
  return deck.filter((c) => isVocab(c) && inSource(c, source));
}

function allConceptCards(source) {
  return deck.filter((c) => !isBuilder(c) && c.concept_id && inSource(c, source));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// direction: 'mixed' keeps each word once (random direction when both exist),
// 'tr-en' keeps only recognition cards, 'en-tr' only production. Non-vocab
// cards always pass through.
const directionOk = (c, direction = settings.direction) =>
  !isVocab(c) || direction === "mixed"
  || c.type === (direction === "tr-en" ? "vocab_recognition" : "vocab_production");

function applyDirection(cards, direction) {
  if (direction !== "mixed") return cards.filter((c) => directionOk(c, direction));
  const result = [];
  const slotByWord = new Map(); // base card id (word) -> index in result
  for (const c of cards) {
    if (!isVocab(c)) { result.push(c); continue; }
    const word = c.id.replace(/_(recog|prod)$/, "");
    if (!slotByWord.has(word)) {
      slotByWord.set(word, result.length);
      result.push(c);
    } else if (Math.random() < 0.5) {
      result[slotByWord.get(word)] = c;
    }
  }
  return result;
}

// kind: 'vocab' = the two vocab card types, 'concept' = everything else
// (morph_breakdown + grammar_generative); every card is exactly one of the two
const kindMatch = (c, kind) =>
  !kind ? true : kind === "vocab" ? isVocab(c) : !isVocab(c);

// all reviewed cards of a kind, regardless of due date, weakest first —
// sorted by FSRS retrievability (current recall probability), which already
// combines last grade, card difficulty, and time since last review
function learnedQueue(kind) {
  const reviews = effectiveReviews();
  const today = todayIso();
  return deck
    .filter((c) => !isBuilder(c) && kindMatch(c, kind) && directionOk(c) && reviews[c.id])
    .map((c) => {
      const st = reviews[c.id];
      const last = st.history[st.history.length - 1].date;
      return { c, r: retrievability(Math.max(daysBetween(last, today), 0), st.stability) };
    })
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c);
}

// recognition-before-production (scaffolding): a production card waits until
// its recognition sibling has left the multiple-choice rung
function gated(card, reviews) {
  if (!settings.scaffold) return false;
  return isGated(card, reviews, deckIds());
}
let _deckIds = null;
function deckIds() {
  if (!_deckIds || _deckIds.size !== deck.length) _deckIds = new Set(deck.map((c) => c.id));
  return _deckIds;
}

// how many never-reviewed cards may still be started today
function newBudget(reviews) {
  if (!settings.newPerDay) return Infinity;
  return Math.max(settings.newPerDay - introducedOn(reviews, todayIso()), 0);
}

// never-reviewed cards of a kind, in deck order (follows source order),
// minus gated production cards and the other vocab direction, capped by
// today's new-card budget (uncapped: everything currently unlocked). The
// direction filter must run before the cap, or the budget fills with cards
// the session then drops.
function newQueue(kind, { uncapped = false } = {}) {
  const reviews = effectiveReviews();
  const cards = deck.filter((c) => !isBuilder(c) && kindMatch(c, kind) && directionOk(c)
    && !reviews[c.id] && !gated(c, reviews));
  return uncapped ? cards : cards.slice(0, newBudget(reviews));
}

function buildSessionQueue(filter, direction) {
  const cards =
    filter.practiceAll === "concepts" ? shuffle(allConceptCards(filter.source))
    : filter.practiceAll ? shuffle(allVocabCards(filter.source))
    : filter.mode === "learned" ? learnedQueue(filter.kind)
    : filter.mode === "new" ? newQueue(filter.kind)
    : dueQueue(filter);
  return applyDirection(cards, direction);
}

function dueQueue(filter = {}) {
  const reviews = effectiveReviews();
  const today = todayIso();
  const rows = [];
  let budget = newBudget(reviews);
  for (const card of deck) {
    if (isBuilder(card)) continue;
    if (filter.source && !inSource(card, filter.source)) continue;
    if (filter.kind && !kindMatch(card, filter.kind)) continue;
    if (!directionOk(card)) continue;
    if (filter.concept && card.concept_id !== filter.concept) continue;
    if (gated(card, reviews)) continue;
    const st = reviews[card.id];
    if (!st) { if (budget-- > 0) rows.push({ card, sort: "1~new" }); }
    else if (st.due <= today) rows.push({ card, sort: "0~" + st.due });
  }
  rows.sort((a, b) => a.sort.localeCompare(b.sort)); // overdue first, oldest due first, then new
  return rows.map((r) => r.card);
}

// ---------------------------------------------------------------- GitHub API

function apiUrl(path) {
  return `https://api.github.com/repos/${settings.owner}/${settings.repo}/contents/${path}`;
}
function headers() {
  return {
    Authorization: `Bearer ${settings.pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function ghGetJson(path) {
  const res = await fetch(apiUrl(path), { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  const body = await res.json();
  return { data: JSON.parse(b64ToUtf8(body.content)), sha: body.sha };
}
async function ghPutJson(path, obj, sha, message) {
  const res = await fetch(apiUrl(path), {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      message,
      content: utf8ToB64(JSON.stringify(obj, null, 2) + "\n"),
      sha,
    }),
  });
  if (!res.ok) throw new Error(`PUT ${path}: ${res.status}`);
  return (await res.json()).content.sha;
}

// ---------------------------------------------------------------- sync

let syncing = false;

async function sync() {
  if (syncing) return;
  if (!settings.pat) { setSyncStatus("no PAT — set one in settings"); return; }
  syncing = true;
  setSyncStatus("syncing…");
  try {
    const deckRes = await ghGetJson("data/deck.json");
    deck = deckRes.data;
    save(LS.deck, deck);

    // display names for the deck picker (read-only; cosmetic, so failures keep old ones)
    try {
      const [src, con] = await Promise.all([
        ghGetJson("data/sources.json"), ghGetJson("data/concepts.json")]);
      labels = {};
      for (const s of src.data) labels[s.id] = s.artist ? `${s.title} — ${s.artist}` : s.title;
      for (const c of con.data) labels[c.id] = c.name;
      save(LS.labels, labels);
    } catch { /* ignore */ }

    // sentence_build tile inventory (read-only; absent in older data repos)
    try {
      const inv = await ghGetJson("data/morphemes.json");
      save(LS.morphemes, inv.data);
    } catch { /* ignore */ }

    let remote = await ghGetJson("data/reviews.json");
    if (pending.length > 0) {
      const n = new Set(pending.map((p) => p.card_id)).size;
      const message = `review session ${todayIso()}, ${n} cards`;
      try {
        const newSha = await ghPutJson("data/reviews.json",
          replayOnto(remote.data), remote.sha, message);
        base = { data: replayOnto(remote.data), sha: newSha };
      } catch (e) {
        // contents API rejects a stale sha (409/422): re-fetch and retry once
        remote = await ghGetJson("data/reviews.json");
        const newSha = await ghPutJson("data/reviews.json",
          replayOnto(remote.data), remote.sha, message);
        base = { data: replayOnto(remote.data), sha: newSha };
      }
      pending = [];
      save(LS.pending, pending);
    } else {
      base = { data: remote.data, sha: remote.sha };
    }
    save(LS.base, base);
    save(LS.lastSync, { time: new Date().toISOString(), ok: true });
    setSyncStatus(syncStatusLine());
    renderDecks();
  } catch (e) {
    save(LS.lastSync, { time: new Date().toISOString(), ok: false, error: String(e) });
    setSyncStatus(syncStatusLine());
  } finally {
    syncing = false;
  }
}

function replayOnto(remoteReviews) {
  const merged = structuredClone(remoteReviews);
  for (const p of pending) {
    merged[p.card_id] = applyReview(merged[p.card_id] ?? null, p.grade, p.date, p.detail);
  }
  return merged;
}

function syncStatusLine() {
  const ls = load(LS.lastSync, null);
  const parts = [];
  if (ls) {
    parts.push(`last sync: ${ls.time.slice(0, 16).replace("T", " ")} ${ls.ok ? "ok" : "FAILED"}`);
    if (!ls.ok) parts.push(ls.error);
  } else parts.push("never synced");
  if (pending.length) parts.push(`${pending.length} grades queued locally`);
  if (!navigator.onLine) parts.push("offline");
  return parts.join("\n");
}

function setSyncStatus(text) {
  document.getElementById("sync-status").textContent = text;
  const done = document.getElementById("session-sync-status");
  if (done) done.textContent = text;
}

// ---------------------------------------------------------------- review session

// introduced: cards shown as an intro (study) card this session — they come
// back a few cards later as a real retrieval; never persisted, so a session
// abandoned mid-way simply re-introduces them next time.
let session = { queue: [], reviewed: new Set(), introduced: new Set(), flipped: false, active: false,
                mode: "recall", hints: 0 };

// starts immediately — the vocab direction is a global setting, not asked per session
function startSession(filter) {
  const queue = buildSessionQueue(filter, settings.direction);
  session = { queue, total: new Set(queue.map((c) => c.id)).size, reviewed: new Set(),
              introduced: new Set(), flipped: false, active: true, mode: "recall", hints: 0 };
  showView("review");
  renderCard();
}

// end a running session early: emptying the queue routes through the normal
// session-done path, which shows the summary and syncs any recorded grades
function endSession() {
  if (session.reviewed.size === 0) { session.active = false; showView("decks"); return; }
  session.queue = [];
  renderCard();
}

function currentCard() { return session.queue[0]; }

function renderCard() {
  const card = currentCard();
  const doneEl = document.getElementById("session-done");
  const cardEl = document.getElementById("card");
  const gradeRow = document.getElementById("grade-row");
  const hint = document.getElementById("flip-hint");
  document.querySelector("main").scrollTop = 0;
  document.getElementById("review-bar").hidden = !card;
  if (!card) {
    cardEl.hidden = true; gradeRow.hidden = true; hint.hidden = true;
    document.getElementById("btn-exit-session").hidden = true;
    doneEl.hidden = false;
    document.getElementById("review-progress").textContent = "";
    document.getElementById("session-summary").textContent =
      session.reviewed.size === 0 ? "nothing due 🎉" : `session done — ${session.reviewed.size} cards reviewed`;
    if (session.reviewed.size > 0) sync(); // push grades at session end
    return;
  }
  doneEl.hidden = true; cardEl.hidden = false;
  document.getElementById("btn-exit-session").hidden = false;
  session.flipped = false;
  session.hints = 0;
  const st = effectiveReviews()[card.id];

  // ladder rung for this showing (BUILD.md §10): a never-reviewed card is
  // studied first (intro), then comes back as multiple choice (vocab) or
  // recall; weak vocab cards stay on multiple choice until 2 successes in a row
  if (!settings.scaffold) session.mode = "recall";
  else if (!st && !session.introduced.has(card.id)) session.mode = "intro";
  else session.mode = rung(card, st);

  // done = cards gone from the queue for good (failed and intro cards come back)
  const done = session.total - new Set(session.queue.map((c) => c.id)).size;
  const modeLabel = { intro: "new — read it", mc: "multiple choice", recall: "" }[session.mode];
  document.getElementById("review-progress").textContent =
    `${done}/${session.total} · ${card.type.replace("_", " ")}${modeLabel ? " · " + modeLabel : ""}`;
  document.querySelector("#review-bar > div").style.width = `${(100 * done) / session.total}%`;
  document.getElementById("card-front").textContent = card.front;
  document.getElementById("card-answer").textContent = card.back;
  document.getElementById("card-explanation").textContent = card.explanation || "";
  document.getElementById("card-hint").hidden = true;
  document.getElementById("card-hint").textContent = "";
  document.getElementById("mc-options").hidden = true;
  document.getElementById("mc-options").innerHTML = "";
  document.getElementById("intro-row").hidden = true;
  document.getElementById("mc-next-row").hidden = true;
  document.getElementById("hint-row").hidden = true;
  cardEl.classList.remove("intro");
  // previous grades, revealed only with the back so the recall attempt stays unprimed
  const histEl = document.getElementById("card-history");
  if (st) {
    const last = st.history[st.history.length - 1];
    const days = Math.max(daysBetween(last.date, todayIso()), 0);
    const ago = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
    const names = ["fail", "hard", "good", "easy"];
    const trail = st.history.slice(-5).map((h) => names[h.grade]).join(" · ");
    histEl.textContent = `${st.history.length}× reviewed, last ${ago} — ${trail}`;
  }
  histEl.hidden = !st;
  gradeRow.hidden = true;

  if (session.mode === "intro") {
    // study exposure: both sides up, no grade; the card returns shortly
    cardEl.classList.add("intro");
    document.getElementById("card-back").hidden = false;
    hint.hidden = true;
    document.getElementById("intro-row").hidden = false;
  } else if (session.mode === "mc") {
    document.getElementById("card-back").hidden = true;
    hint.hidden = true;
    renderOptions(card);
  } else {
    document.getElementById("card-back").hidden = true;
    hint.hidden = false;
    session.hintList = settings.scaffold ? hintsFor(card) : [];
    renderHintButton();
  }
}

// intro acknowledged: the card re-enters the queue a couple of cards later
function introDone() {
  const card = currentCard();
  if (!card || session.mode !== "intro") return;
  session.introduced.add(card.id);
  session.queue.shift();
  session.queue.splice(Math.min(2, session.queue.length), 0, card);
  renderCard();
}

function renderOptions(card) {
  const box = document.getElementById("mc-options");
  const opts = buildOptions(card, deck, effectiveReviews());
  box.innerHTML = opts.map((o, i) =>
    `<button class="mc-opt" data-i="${i}" ${o.correct ? 'data-correct="1"' : ""}>${esc(o.text)}</button>`).join("");
  box.hidden = false;
  box.querySelectorAll(".mc-opt").forEach((b) => b.addEventListener("click", () => chooseOption(b)));
}

// multiple choice is auto-graded: correct → 1 (Hard: the format retrieves
// less than recall, so it schedules conservatively), wrong → 0 (repeats today)
function chooseOption(btn) {
  if (session.flipped) return;
  session.flipped = true;
  const correct = btn.dataset.correct === "1";
  btn.classList.add(correct ? "right" : "wrong");
  document.querySelectorAll(".mc-opt").forEach((b) => {
    b.disabled = true;
    if (b.dataset.correct === "1") b.classList.add("right");
  });
  document.getElementById("card-back").hidden = false;
  document.getElementById("mc-next-row").hidden = false;
  document.getElementById("btn-mc-next").textContent = correct ? "correct → next" : "wrong → next";
  session.mcGrade = correct ? 1 : 0;
}

function mcNext() {
  const card = currentCard();
  if (!card || session.mode !== "mc" || !session.flipped) return;
  record(card, session.mcGrade, { mode: "mc" });
}

function renderHintButton() {
  const row = document.getElementById("hint-row");
  const btn = document.getElementById("btn-hint");
  const left = session.hintList.length - session.hints;
  row.hidden = left <= 0;
  if (left > 0) btn.textContent = `hint: ${session.hintList[session.hints].label} (caps grade at ${gradeCap(session.hints + 1)})`;
}

// graded hints (cued recall): each one lowers the best grade available —
// 1 hint → good at most, 2 hints → hard at most
function showHint() {
  if (session.mode !== "recall" || session.flipped) return;
  if (session.hints >= session.hintList.length) return;
  const h = session.hintList[session.hints++];
  const el = document.getElementById("card-hint");
  el.hidden = false;
  el.textContent += (el.textContent ? "\n" : "") + h.text;
  renderHintButton();
}

function flip() {
  if (!currentCard() || session.flipped || session.mode !== "recall") return;
  session.flipped = true;
  document.getElementById("card-back").hidden = false;
  document.getElementById("flip-hint").hidden = true;
  document.getElementById("hint-row").hidden = true;
  const cap = gradeCap(session.hints);
  document.querySelectorAll("#grade-row .grade").forEach((b) => { b.disabled = Number(b.dataset.grade) > cap; });
  document.getElementById("grade-row").hidden = false;
}

function grade(g) {
  const card = currentCard();
  if (!card || !session.flipped || session.mode !== "recall") return;
  if (g > gradeCap(session.hints)) return;
  record(card, g, session.hints ? { mode: "recall", hints: session.hints } : undefined);
}

function record(card, g, detail) {
  pending.push(detail ? { card_id: card.id, grade: g, date: todayIso(), detail }
                      : { card_id: card.id, grade: g, date: todayIso() });
  save(LS.pending, pending);
  session.reviewed.add(card.id);
  session.queue.shift();
  if (g === 0) session.queue.push(card); // blackout: repeat today, end of queue
  renderCard();
}

// ---------------------------------------------------------------- deck picker

let picker = { screen: "home" }; // home | vocab | concepts | sources | {screen:'source', id}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function renderDecks() {
  const el = document.getElementById("deck-lists");
  if (deck.length === 0) {
    el.innerHTML = `<h1>türkçe</h1><p>no deck cached yet — sync in settings.</p>`;
    return;
  }

  // a data-filter button starts session setup; a data-nav button navigates
  const filterItem = (text, count, filter) =>
    `<button class="deck-item" data-filter='${JSON.stringify(filter)}' ${count === 0 ? "disabled" : ""}>
       <span lang="tr">${esc(text)}</span><span class="count">${count}</span></button>`;
  const navItem = (text, badge, nav) =>
    `<button class="deck-item" data-nav='${JSON.stringify(nav)}'>
       <span lang="tr">${esc(text)}</span><span class="count">${esc(badge)} ›</span></button>`;
  const header = (title, backNav) =>
    `<div class="picker-header"><button class="back-btn" data-nav='${JSON.stringify(backNav)}'>‹</button>
       <h1 lang="tr">${esc(title)}</h1></div>`;
  // counts are the session size: same queue, same direction pass (mixed keeps a word once)
  const n = (cards) => applyDirection(cards, settings.direction).length;
  const sectionRows = (kind) => {
    const today = n(newQueue(kind)), waiting = n(newQueue(kind, { uncapped: true }));
    const newText = waiting > today ? `learn new — ${today} of ${waiting} (daily cap)` : "learn new";
    return `<div class="deck-group">
    ${filterItem("due", n(dueQueue({ kind })), { kind })}
    ${filterItem("repeat learned — weakest first", n(learnedQueue(kind)), { kind, mode: "learned" })}
    ${filterItem(newText, today, { kind, mode: "new" })}
  </div>`;
  };

  const sourceIds = [...new Set(deck.flatMap((c) => c.source_ids))];
  let html;

  if (picker.screen === "home") {
    const dueAll = n(dueQueue({}));
    html = `<h1>türkçe</h1>
      <button id="btn-review-all" data-filter='{}' ${dueAll === 0 ? "disabled" : ""}>
        review<span class="count">${dueAll} due + new</span></button>
      <div class="deck-group"><h2>browse</h2>
        ${navItem("vocab", `${n(dueQueue({ kind: "vocab" }))} due`, { screen: "vocab" })}
        ${navItem("concepts", `${n(dueQueue({ kind: "concept" }))} due`, { screen: "concepts" })}
        ${navItem("sources", `${sourceIds.length}`, { screen: "sources" })}
      </div>`;
  } else if (picker.screen === "vocab") {
    html = header("vocab", { screen: "home" }) + sectionRows("vocab");
  } else if (picker.screen === "concepts") {
    const perConcept = new Map();
    for (const c of deck) if (c.concept_id) perConcept.set(c.concept_id, 0);
    for (const c of dueQueue({ kind: "concept" }))
      if (c.concept_id) perConcept.set(c.concept_id, perConcept.get(c.concept_id) + 1);
    html = header("concepts", { screen: "home" }) + sectionRows("concept")
      + `<div class="deck-group"><h2>single concept — due</h2>${
        [...perConcept].map(([c, due]) => filterItem(label(c), due, { concept: c })).join("")}</div>`;
  } else if (picker.screen === "sources") {
    html = header("sources", { screen: "home" }) + `<div class="deck-group">${
      sourceIds.map((s) => navItem(label(s), `${n(dueQueue({ source: s }))} due`,
        { screen: "source", id: s })).join("")}</div>`;
  } else { // one source
    const s = picker.id;
    html = header(label(s), { screen: "sources" }) + `<div class="deck-group">
      ${filterItem("due", n(dueQueue({ source: s })), { source: s })}
      ${filterItem("practice — all vocab", n(allVocabCards(s)), { source: s, practiceAll: true })}
      ${filterItem("practice — all concepts", allConceptCards(s).length, { source: s, practiceAll: "concepts" })}
    </div>`;
  }

  el.innerHTML = html;
  el.querySelectorAll("[data-filter]").forEach((btn) =>
    btn.addEventListener("click", () => startSession(JSON.parse(btn.dataset.filter))));
  el.querySelectorAll("[data-nav]").forEach((btn) =>
    btn.addEventListener("click", () => { picker = JSON.parse(btn.dataset.nav); renderDecks(); }));
}

// ---------------------------------------------------------------- views & wiring

function showView(name) {
  // main scrolls as one box; a scroll offset left over from the previous view
  // would start the new one with its header tucked under the status bar
  document.querySelector("main").scrollTop = 0;
  for (const v of ["decks", "review", "builder", "settings"]) {
    document.getElementById(`view-${v}`).hidden = v !== name;
  }
  document.querySelectorAll("nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  if (name === "decks") renderDecks();
  if (name === "builder") renderBuilderHome();
  if (name === "settings") setSyncStatus(syncStatusLine());
}

document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.view === "review") {
      if (session.active) showView("review");
      else startSession({});
    } else {
      session.active = false;
      if (b.dataset.view === "decks") picker = { screen: "home" };
      showView(b.dataset.view);
    }
  }));
document.getElementById("btn-exit-session").addEventListener("click", endSession);
document.getElementById("card").addEventListener("click", flip);
document.getElementById("btn-intro-done").addEventListener("click", introDone);
document.getElementById("btn-mc-next").addEventListener("click", mcNext);
document.getElementById("btn-hint").addEventListener("click", showHint);
document.querySelectorAll("#grade-row .grade").forEach((b) =>
  b.addEventListener("click", () => grade(Number(b.dataset.grade))));
document.getElementById("btn-back-to-decks").addEventListener("click", () => { session.active = false; showView("decks"); });

document.getElementById("btn-save-settings").addEventListener("click", () => {
  settings = {
    owner: document.getElementById("set-owner").value.trim() || "matzeyp",
    repo: document.getElementById("set-repo").value.trim() || "turkce",
    pat: document.getElementById("set-pat").value.trim(),
    direction: document.querySelector("input[name=direction]:checked").value,
    builderDelay: document.getElementById("set-builder-delay").checked,
    scaffold: document.getElementById("set-scaffold").checked,
    newPerDay: Math.max(parseInt(document.getElementById("set-new-per-day").value, 10) || 0, 0),
  };
  save(LS.settings, settings);
  setSyncStatus("saved.");
});
document.getElementById("btn-sync").addEventListener("click", sync);
window.addEventListener("online", () => { if (pending.length) sync(); });

// sentence-builder tab: reads the same deck + review state, records through the
// same pending queue (detail rides along into the history entry)
initBuilder({
  getDeck: () => deck,
  getReviews: effectiveReviews,
  getMorphemes: () => load(LS.morphemes, null),
  getSettings: () => settings,
  label,
  record: (cardId, grade, detail) => {
    pending.push({ card_id: cardId, grade, date: todayIso(), detail });
    save(LS.pending, pending);
  },
  onSessionEnd: () => { if (pending.length) sync(); },
});

// init
document.getElementById("set-owner").value = settings.owner;
document.getElementById("set-repo").value = settings.repo;
document.getElementById("set-pat").value = settings.pat;
document.querySelector(`input[name=direction][value="${settings.direction}"]`).checked = true;
document.getElementById("set-builder-delay").checked = settings.builderDelay !== false;
document.getElementById("set-scaffold").checked = settings.scaffold !== false;
document.getElementById("set-new-per-day").value = settings.newPerDay;
showView(settings.pat ? "decks" : "settings");
if (settings.pat && navigator.onLine) sync();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}

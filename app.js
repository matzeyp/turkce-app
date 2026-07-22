// türkçe review app — deliberately dumb practice client.
// Reads data/deck.json, writes ONLY data/reviews.json, both in the private
// data repo via the GitHub contents API. All intelligence lives in the data
// repo's Claude Code layer; this app shows cards, records grades, runs FSRS.
import { applyReview, todayIso } from "./fsrs.js";

const LS = {
  settings: "turkce.settings",
  deck: "turkce.deck",
  labels: "turkce.labels",      // id -> display name (source titles, concept names)
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
    reviews[p.card_id] = applyReview(reviews[p.card_id] ?? null, p.grade, p.date);
  }
  return reviews;
}

const isVocab = (c) => c.type === "vocab_recognition" || c.type === "vocab_production";

function allVocabCards(source) {
  return deck.filter((c) => isVocab(c) && c.source_ids.includes(source));
}

function allConceptCards(source) {
  return deck.filter((c) => c.concept_id && c.source_ids.includes(source));
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
function applyDirection(cards, direction) {
  if (direction === "tr-en") return cards.filter((c) => !isVocab(c) || c.type === "vocab_recognition");
  if (direction === "en-tr") return cards.filter((c) => !isVocab(c) || c.type === "vocab_production");
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

function buildSessionQueue(filter, direction) {
  const cards =
    filter.practiceAll === "concepts" ? shuffle(allConceptCards(filter.source))
    : filter.practiceAll ? shuffle(allVocabCards(filter.source))
    : dueQueue(filter);
  return applyDirection(cards, direction);
}

function dueQueue(filter = {}) {
  const reviews = effectiveReviews();
  const today = todayIso();
  const rows = [];
  for (const card of deck) {
    if (filter.source && !card.source_ids.includes(filter.source)) continue;
    if (filter.type && card.type !== filter.type) continue;
    if (filter.concept && card.concept_id !== filter.concept) continue;
    const st = reviews[card.id];
    if (!st) rows.push({ card, sort: "1~new" });
    else if (st.due <= today) rows.push({ card, sort: "0~" + st.due });
  }
  rows.sort((a, b) => a.sort.localeCompare(b.sort)); // overdue first, oldest due first
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
    merged[p.card_id] = applyReview(merged[p.card_id] ?? null, p.grade, p.date);
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

let session = { queue: [], reviewed: new Set(), flipped: false, active: false };
let setupFilter = {};

function openSetup(filter) {
  setupFilter = filter;
  session.active = false;
  showView("review");
  for (const id of ["card", "grade-row", "session-done", "btn-exit-session"]) document.getElementById(id).hidden = true;
  document.getElementById("flip-hint").hidden = true;
  document.getElementById("review-progress").textContent = "";
  const desc = filter.practiceAll === "concepts" ? `${label(filter.source)} — all concepts`
    : filter.practiceAll ? `${label(filter.source)} — all vocab`
    : filter.source ? `${label(filter.source)} — due`
    : filter.type ? `${filter.type.replace("_", " ")} — due`
    : filter.concept ? `${label(filter.concept)} — due`
    : "all due + new";
  document.getElementById("setup-desc").textContent = desc;
  const noVocab = filter.practiceAll === "concepts"; // direction is meaningless without vocab cards
  document.getElementById("setup-direction").hidden = noVocab;
  document.getElementById("setup-direction-note").hidden = noVocab;
  document.getElementById("session-setup").hidden = false;
}

function startSession() {
  const direction = document.querySelector("input[name=direction]:checked").value;
  document.getElementById("session-setup").hidden = true;
  session = { queue: buildSessionQueue(setupFilter, direction), reviewed: new Set(), flipped: false, active: true };
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
  doneEl.hidden = true; cardEl.hidden = false; hint.hidden = false;
  document.getElementById("btn-exit-session").hidden = false;
  session.flipped = false;
  document.getElementById("review-progress").textContent =
    `${session.queue.length} left · ${card.type.replace("_", " ")}`;
  document.getElementById("card-front").textContent = card.front;
  document.getElementById("card-back").hidden = true;
  document.getElementById("card-answer").textContent = card.back;
  document.getElementById("card-explanation").textContent = card.explanation || "";
  gradeRow.hidden = true;
}

function flip() {
  if (!currentCard() || session.flipped) return;
  session.flipped = true;
  document.getElementById("card-back").hidden = false;
  document.getElementById("flip-hint").hidden = true;
  document.getElementById("grade-row").hidden = false;
}

function grade(g) {
  const card = currentCard();
  if (!card || !session.flipped) return;
  pending.push({ card_id: card.id, grade: g, date: todayIso() });
  save(LS.pending, pending);
  session.reviewed.add(card.id);
  session.queue.shift();
  if (g === 0) session.queue.push(card); // blackout: repeat today, end of queue
  renderCard();
}

// ---------------------------------------------------------------- deck picker

function renderDecks() {
  const el = document.getElementById("deck-lists");
  const all = dueQueue();
  const groups = [];

  const sources = new Map();
  const types = new Map();
  const concepts = new Map();
  for (const card of all) {
    for (const s of card.source_ids) sources.set(s, (sources.get(s) ?? 0) + 1);
    types.set(card.type, (types.get(card.type) ?? 0) + 1);
    if (card.concept_id) concepts.set(card.concept_id, (concepts.get(card.concept_id) ?? 0) + 1);
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const item = (text, count, filter) =>
    `<button class="deck-item" data-filter='${JSON.stringify(filter)}' ${count === 0 ? "disabled" : ""}>
       <span lang="tr">${esc(text)}</span><span class="count">${count}</span></button>`;

  const vocabSources = new Map();
  const conceptSources = new Map();
  for (const card of deck) {
    const m = isVocab(card) ? vocabSources : card.concept_id ? conceptSources : null;
    if (m) for (const s of card.source_ids) m.set(s, (m.get(s) ?? 0) + 1);
  }

  groups.push(`<div class="deck-group">${item("all due + new", all.length, {})}</div>`);
  if (sources.size) groups.push(`<div class="deck-group"><h2>by source</h2>${
    [...sources].map(([s, n]) => item(label(s), n, { source: s })).join("")}</div>`);
  if (vocabSources.size) groups.push(`<div class="deck-group"><h2>practice — all vocab of a source</h2>${
    [...vocabSources].map(([s, n]) => item(label(s), n, { source: s, practiceAll: true })).join("")}</div>`);
  if (conceptSources.size) groups.push(`<div class="deck-group"><h2>practice — all concepts of a source</h2>${
    [...conceptSources].map(([s, n]) => item(label(s), n, { source: s, practiceAll: "concepts" })).join("")}</div>`);
  if (types.size) groups.push(`<div class="deck-group"><h2>by card type</h2>${
    [...types].map(([t, n]) => item(t.replace("_", " "), n, { type: t })).join("")}</div>`);
  if (concepts.size) groups.push(`<div class="deck-group"><h2>by concept</h2>${
    [...concepts].map(([c, n]) => item(label(c), n, { concept: c })).join("")}</div>`);
  if (deck.length === 0) groups.push(`<p>no deck cached yet — sync in settings.</p>`);

  el.innerHTML = groups.join("");
  el.querySelectorAll(".deck-item").forEach((btn) =>
    btn.addEventListener("click", () => openSetup(JSON.parse(btn.dataset.filter))));
}

// ---------------------------------------------------------------- views & wiring

function showView(name) {
  for (const v of ["decks", "review", "settings"]) {
    document.getElementById(`view-${v}`).hidden = v !== name;
  }
  document.querySelectorAll("nav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  if (name === "decks") renderDecks();
  if (name === "settings") setSyncStatus(syncStatusLine());
}

document.querySelectorAll("nav button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.view === "review") {
      if (session.active) showView("review");
      else openSetup({});
    } else {
      session.active = false;
      showView(b.dataset.view);
    }
  }));
document.getElementById("btn-start-session").addEventListener("click", startSession);
document.getElementById("btn-exit-session").addEventListener("click", endSession);
document.getElementById("card").addEventListener("click", flip);
document.querySelectorAll("#grade-row .grade").forEach((b) =>
  b.addEventListener("click", () => grade(Number(b.dataset.grade))));
document.getElementById("btn-back-to-decks").addEventListener("click", () => { session.active = false; showView("decks"); });

document.getElementById("btn-save-settings").addEventListener("click", () => {
  settings = {
    owner: document.getElementById("set-owner").value.trim() || "matzeyp",
    repo: document.getElementById("set-repo").value.trim() || "turkce",
    pat: document.getElementById("set-pat").value.trim(),
  };
  save(LS.settings, settings);
  setSyncStatus("saved.");
});
document.getElementById("btn-sync").addEventListener("click", sync);
window.addEventListener("online", () => { if (pending.length) sync(); });

// init
document.getElementById("set-owner").value = settings.owner;
document.getElementById("set-repo").value = settings.repo;
document.getElementById("set-pat").value = settings.pat;
showView(settings.pat ? "decks" : "settings");
if (settings.pat && navigator.onLine) sync();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}

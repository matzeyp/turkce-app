// Sentence-analysis drill (data repo BUILD.md §11): a Turkish sentence from a
// source, every word pre-split into pieces; the learner picks the meaning of
// each stem and suffix from a dropdown. The app stays dumb: segmentation,
// answers and distractors are card data; grading is a string comparison.

let ctx = null;      // { getDeck, getReviews, label, record, onSessionEnd }
let s = null;        // active session: { queue, total, reviewed }
let play = null;     // active card: { card, checks, firstErrors, choices, done }

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const isAnalysis = (c) => c.type === "sentence_analysis";
const asked = (p) => p.kind === "stem" || p.kind === "suffix";

function analysisCards() { return ctx.getDeck().filter(isAnalysis); }

// reviewed and due only: new sentences are started per source, in order
function dueQueue() {
  const reviews = ctx.getReviews();
  const today = new Date().toISOString().slice(0, 10);
  return analysisCards()
    .filter((c) => reviews[c.id] && reviews[c.id].due <= today)
    .sort((a, b) => reviews[a.id].due.localeCompare(reviews[b.id].due));
}

function sourceQueue(source) {
  return analysisCards().filter((c) => c.source_ids[0] === source).sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------- home

export function renderAnalysisHome() {
  if (s && s.reviewed.size > 0) ctx.onSessionEnd();
  s = null;
  play = null;
  $("analysis-play").hidden = true;
  const el = $("analysis-lists");
  const cards = analysisCards();
  if (cards.length === 0) {
    el.innerHTML = "<p>no sentence cards cached yet — sync in settings.</p>";
    return;
  }
  const reviews = ctx.getReviews();
  const sources = [...new Set(cards.map((c) => c.source_ids[0]))];
  const item = (text, count, value, extra = "") =>
    `<button class="deck-item" data-sa="${esc(value)}" ${count === 0 ? "disabled" : ""}>
       <span lang="tr">${esc(text)}</span><span class="count">${esc(extra || count)}</span></button>`;
  el.innerHTML = item("due", dueQueue().length, "__due")
    + sources.map((src) => {
      const all = sourceQueue(src);
      const seen = all.filter((c) => reviews[c.id]).length;
      return item(ctx.label(src), all.length, src, `${seen}/${all.length}`);
    }).join("");
  el.querySelectorAll("[data-sa]").forEach((btn) =>
    btn.addEventListener("click", () => start(btn.dataset.sa)));
}

function start(which) {
  const queue = which === "__due" ? dueQueue() : sourceQueue(which);
  s = { queue, total: new Set(queue.map((c) => c.id)).size, reviewed: new Set() };
  $("builder-home").hidden = true;
  $("analysis-play").hidden = false;
  next();
}

function end() {
  renderAnalysisHome();
  $("builder-home").hidden = false;
}

// ---------------------------------------------------------------- play

function next() {
  const card = s.queue[0];
  document.querySelector("main").scrollTop = 0;
  $("sa-result").hidden = true;
  $("sa-done").hidden = true;
  $("sa-bar").hidden = !card;
  if (!card) {
    ["sa-progress", "sa-front", "sa-words", "sa-feedback"].forEach((id) => { $(id).textContent = ""; });
    $("sa-actions").hidden = true;
    $("sa-done").hidden = false;
    $("sa-summary").textContent = s.reviewed.size === 0
      ? "nothing due 🎉" : `session done — ${s.reviewed.size} sentences analysed`;
    if (s.reviewed.size > 0) ctx.onSessionEnd();
    return;
  }
  const done = s.total - new Set(s.queue.map((c) => c.id)).size;
  $("sa-progress").textContent = `${done}/${s.total} · sentence analysis`;
  $("sa-bar").firstElementChild.style.width = `${(100 * done) / s.total}%`;
  play = { card, checks: 0, firstErrors: null, done: false,
           choices: card.words.reduce((n, w) => n + w.pieces.filter(asked).length, 0) };
  $("sa-front").textContent = card.front;
  $("sa-feedback").textContent = "";
  $("sa-actions").hidden = false;
  renderWords();
}

// one block per word; one select per asked piece, options shuffled once here
function renderWords() {
  const { card } = play;
  $("sa-words").innerHTML = card.words.map((w, wi) => `
    <div class="sa-word">
      <div class="sa-word-surface" lang="tr">${esc(w.surface)}</div>
      <div class="sa-pieces${w.pieces.length === 1 ? " single" : ""}">${
        w.pieces.map((p, pi) => piece(p, wi, pi)).join("")}</div>
    </div>`).join("");
  $("sa-words").querySelectorAll("select").forEach((sel) =>
    sel.addEventListener("change", () => sel.classList.remove("wrong")));

  function piece(p, wi, pi) {
    const surface = `<span class="sa-piece-surface" lang="tr">${esc(p.surface)}</span>`;
    if (p.kind === "buffer") return `<div class="sa-piece buffer">${surface}</div>`;
    if (p.kind === "given") {
      return `<div class="sa-piece given">${surface}<span class="sa-given">${esc(p.answer)}</span></div>`;
    }
    const opts = shuffle([p.answer, ...p.distractors]);
    return `<div class="sa-piece ${p.kind}">${surface}
      <select data-w="${wi}" data-p="${pi}" aria-label="${esc(p.surface)}">
        <option value="">—</option>
        ${opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")}
      </select></div>`;
  }
}

function pieceOf(sel) {
  return play.card.words[Number(sel.dataset.w)].pieces[Number(sel.dataset.p)];
}

function check() {
  if (!play || play.done) return;
  const sels = [...$("sa-words").querySelectorAll("select")];
  if (sels.some((sel) => !sel.value)) {
    $("sa-feedback").textContent = "pick a meaning for every part first";
    return;
  }
  play.checks++;
  let stemErr = 0, sufErr = 0;
  for (const sel of sels) {
    const p = pieceOf(sel);
    const ok = sel.value === p.answer;
    sel.classList.toggle("wrong", !ok);
    sel.classList.toggle("right", ok);
    sel.disabled = ok;
    if (!ok) { if (p.kind === "stem") stemErr++; else sufErr++; }
  }
  if (play.firstErrors === null) play.firstErrors = { stem: stemErr, suffix: sufErr };
  const wrong = stemErr + sufErr;
  if (wrong === 0) {
    // all right first try → 3; few first-try errors fixed at once → 2; else 1
    const first = play.firstErrors.stem + play.firstErrors.suffix;
    finish(play.checks === 1 ? 3 : play.checks === 2 && first <= 0.25 * play.choices ? 2 : 1);
    return;
  }
  $("sa-feedback").textContent = `${wrong} of ${play.choices} not right — fix the marked ones`;
}

function reveal() {
  if (!play || play.done) return;
  if (play.firstErrors === null) play.firstErrors = { stem: 0, suffix: 0 };
  for (const sel of $("sa-words").querySelectorAll("select")) {
    const p = pieceOf(sel);
    if (sel.value !== p.answer) sel.classList.add("wrong");
    sel.value = p.answer;
    sel.disabled = true;
  }
  finish(0);
}

function finish(grade) {
  play.done = true;
  const fe = play.firstErrors;
  ctx.record(play.card.id, grade,
    { stem_errors: fe.stem, suffix_errors: fe.suffix, retries: Math.max(play.checks - 1, 0) });
  s.reviewed.add(play.card.id);
  s.queue.shift();
  if (grade === 0) s.queue.push(play.card); // blackout repeats today, end of queue
  const names = ["fail — again today", "hard", "good", "easy"];
  $("sa-feedback").textContent = "";
  $("sa-actions").hidden = true;
  $("sa-result").hidden = false;
  $("sa-grade").textContent = `${grade} · ${names[grade]}`;
  $("sa-back").textContent = play.card.back;
  $("sa-explanation").textContent = play.card.explanation ?? "";
}

// ---------------------------------------------------------------- wiring

export function initAnalysis(context) {
  ctx = context;
  $("btn-sa-check").addEventListener("click", check);
  $("btn-sa-reveal").addEventListener("click", reveal);
  $("btn-sa-next").addEventListener("click", next);
  $("btn-sa-back").addEventListener("click", end);
  $("btn-exit-analysis").addEventListener("click", end);
}

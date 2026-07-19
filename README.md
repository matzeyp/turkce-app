# turkce-app

Static PWA shell for a personal Turkish flashcard system. Vanilla JS, no framework, no build
step. This repo is **public and content-free**: it contains only the app shell. All learning
data lives in a separate private data repo, which the app reads (`data/deck.json`) and writes
(`data/reviews.json` — the only file it ever writes) at runtime via the GitHub contents API,
using a fine-grained PAT that the user pastes into the settings screen (kept in
localStorage only — it never touches this repo or any server).

- `fsrs.js` — FSRS-4.5 scheduler, an exact port of the data repo's `scripts/fsrs.py`.
  Parity is enforced by `tests/fsrs.test.mjs` against `tests/vectors.json` (synthetic
  sequences generated from the Python implementation): `node tests/fsrs.test.mjs`.
- `app.js` — review flow (front → flip → back + explanation → grade 0–3), deck picker with
  due counts by source/type/concept, settings + sync. Offline grades queue in localStorage
  and replay onto the freshly fetched remote state on sync (stale-SHA conflicts retry once).
- `sw.js` — caches the shell for offline; never intercepts api.github.com.

Deployed via GitHub Pages (main branch, root).

## PAT setup

Fine-grained personal access token: GitHub → Settings → Developer settings → Fine-grained
tokens → Generate new token → Repository access: only the private data repo → Permissions:
Contents: Read and write. Paste it into the app's settings screen.

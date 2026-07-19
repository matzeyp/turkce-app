// FSRS parity test: replay tests/vectors.json (generated from the data repo's
// scripts/fsrs.py) through fsrs.js and require exact equality of stability,
// difficulty, and due after every step. Run: node tests/fsrs.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyReview } from "../fsrs.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "vectors.json"), "utf8"));

let steps = 0;
let failures = 0;
for (const [name, seq] of Object.entries(vectors)) {
  let state = null;
  for (const [i, expected] of seq.entries()) {
    state = applyReview(state, expected.grade, expected.date);
    steps++;
    for (const field of ["stability", "difficulty", "due"]) {
      if (state[field] !== expected[field]) {
        failures++;
        console.error(`FAIL ${name}[${i}] ${field}: js=${state[field]} py=${expected[field]}`);
      }
    }
  }
}
if (failures > 0) {
  console.error(`${failures} mismatches across ${steps} steps`);
  process.exit(1);
}
console.log(`OK: ${steps} steps across ${Object.keys(vectors).length} sequences match fsrs.py exactly`);

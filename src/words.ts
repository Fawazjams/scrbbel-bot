// Word engine: sorted-letter-signature trie over the ENABLE word list.
// Racks are Int8Array(26) letter counts.
import * as fs from "node:fs";

export const LETTER_VALUE = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
];
// Standard 98-tile bag (no blanks).
export const BAG_COUNTS = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const VOWEL = new Set([0, 4, 8, 14, 20]);

export function mult(len: number): number {
  if (len <= 3) return 1;
  if (len === 4) return 1.5;
  if (len === 5) return 2;
  if (len === 6) return 2.5;
  return 3;
}
export function rewardOf(base: number, len: number): number {
  return Math.floor(base * mult(len));
}
export function wordReward(word: string): number {
  let b = 0;
  for (let i = 0; i < word.length; i++) b += LETTER_VALUE[word.charCodeAt(i) - 65];
  return rewardOf(b, word.length);
}

export type Rack = Int8Array;
export const li = (ch: string) => ch.charCodeAt(0) - 65;

// Trie keyed by sorted letters. children: Int32Array(nodes*26), -1 = none.
let children = new Int32Array(1 << 20).fill(-1);
let nodeReward = new Int32Array(1 << 15);
let nodeWord: (string | undefined)[] = [];
let nNodes = 1;
let wordCount = 0;

function grow() {
  const cap = (children.length / 26) | 0;
  if (nNodes < cap) return;
  const nc = new Int32Array(children.length * 2).fill(-1);
  nc.set(children);
  children = nc;
}

export function loadWords(path: string): number {
  const text = fs.readFileSync(path, "utf8");
  children = new Int32Array(26 * 600000).fill(-1);
  nodeReward = new Int32Array(600000);
  nodeWord = new Array(600000);
  nNodes = 1;
  wordCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    const w = raw.trim().toUpperCase();
    if (w.length < 2 || !/^[A-Z]+$/.test(w)) continue;
    const codes = Array.from(w, (c) => c.charCodeAt(0) - 65).sort((a, b) => a - b);
    let node = 0;
    for (const c of codes) {
      let nx = children[node * 26 + c];
      if (nx < 0) {
        grow();
        nx = nNodes++;
        if (nx >= nodeReward.length) {
          const nr = new Int32Array(nodeReward.length * 2);
          nr.set(nodeReward);
          nodeReward = nr;
        }
        children[node * 26 + c] = nx;
      }
      node = nx;
    }
    const r = wordReward(w);
    if (nodeWord[node] === undefined) {
      nodeWord[node] = w;
      nodeReward[node] = r;
    }
    wordCount++;
  }
  return wordCount;
}

export interface Cand {
  word: string;
  reward: number;
}

// All formable words (one per signature) from rack.
export function formable(rack: Rack, minLen = 2): Cand[] {
  const out: Cand[] = [];
  const dfs = (node: number, letter: number, depth: number) => {
    for (let L = letter; L < 26; L++) {
      const have = rack[L];
      if (have <= 0) continue;
      let n = node;
      for (let k = 1; k <= have; k++) {
        n = children[n * 26 + L];
        if (n < 0) break;
        if (depth + k >= minLen && nodeWord[n] !== undefined)
          out.push({ word: nodeWord[n]!, reward: nodeReward[n] });
        dfs(n, L + 1, depth + k);
      }
    }
  };
  dfs(0, 0, 0);
  return out;
}

// Best single word reward from rack (fast, no allocation of candidates).
function bestSingle(rack: Rack): number {
  let best = 0;
  const dfs = (node: number, letter: number) => {
    for (let L = letter; L < 26; L++) {
      const have = rack[L];
      if (have <= 0) continue;
      let n = node;
      for (let k = 1; k <= have; k++) {
        n = children[n * 26 + L];
        if (n < 0) break;
        if (nodeWord[n] !== undefined && nodeReward[n] > best) best = nodeReward[n];
        dfs(n, L + 1);
      }
    }
  };
  dfs(0, 0);
  return best;
}

function bestSingleCand(rack: Rack): Cand | null {
  let best: Cand | null = null;
  const dfs = (node: number, letter: number) => {
    for (let L = letter; L < 26; L++) {
      const have = rack[L];
      if (have <= 0) continue;
      let n = node;
      for (let k = 1; k <= have; k++) {
        n = children[n * 26 + L];
        if (n < 0) break;
        if (nodeWord[n] !== undefined && (!best || nodeReward[n] > best.reward))
          best = { word: nodeWord[n]!, reward: nodeReward[n] };
        dfs(n, L + 1);
      }
    }
  };
  dfs(0, 0);
  return best;
}

function sub(rack: Rack, word: string) {
  for (let i = 0; i < word.length; i++) rack[word.charCodeAt(i) - 65]--;
}
function add(rack: Rack, word: string) {
  for (let i = 0; i < word.length; i++) rack[word.charCodeAt(i) - 65]++;
}

// Greedy fill: repeatedly take the best single word.
function greedyFill(rack: Rack, outWords?: string[]): number {
  let total = 0;
  const taken: string[] = [];
  for (;;) {
    const c = bestSingleCand(rack);
    if (!c) break;
    total += c.reward;
    taken.push(c.word);
    sub(rack, c.word);
  }
  for (const w of taken) add(rack, w);
  if (outWords) outWords.push(...taken);
  return total;
}

// Approximate best partition value: try top-N first words, greedy fill rest.
export function partitionValue(rack: Rack, topN = 8): number {
  const cands = formable(rack);
  if (cands.length === 0) return 0;
  cands.sort((a, b) => b.reward - a.reward);
  let best = 0;
  const n = Math.min(topN, cands.length);
  for (let i = 0; i < n; i++) {
    const c = cands[i];
    sub(rack, c.word);
    const v = c.reward + greedyFill(rack);
    add(rack, c.word);
    if (v > best) best = v;
  }
  return best;
}

// Near-exact best partition returning the words (used for final dump / play).
export function bestPartition(rack: Rack, topN = 14, depth = 0): { total: number; words: string[] } {
  const cands = formable(rack);
  if (cands.length === 0) return { total: 0, words: [] };
  cands.sort((a, b) => b.reward - a.reward);
  let best = { total: 0, words: [] as string[] };
  const n = Math.min(depth === 0 ? topN : Math.max(3, topN >> depth), cands.length);
  for (let i = 0; i < n; i++) {
    const c = cands[i];
    sub(rack, c.word);
    let rest: { total: number; words: string[] };
    if (depth < 2) rest = bestPartition(rack, topN, depth + 1);
    else { const ws: string[] = []; rest = { total: greedyFill(rack, ws), words: ws }; }
    add(rack, c.word);
    const tot = c.reward + rest.total;
    if (tot > best.total) best = { total: tot, words: [c.word, ...rest.words] };
  }
  return best;
}

export { bestSingle };

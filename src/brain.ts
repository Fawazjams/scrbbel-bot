// Decision engine: Monte Carlo letter value, coin shadow price (lambda),
// bid choice, play/hold. Original implementation for the SCRBBEL bot.
import { BAG_COUNTS, LETTER_VALUE, VOWEL, partitionValue, formable, bestPartition, type Rack } from "./words.js";

export interface Rival {
  botId: bigint;
  balance: number;
  score: number;
  sim: null | "Cheapskate" | "ValueBidder" | "Aggressive";
}

export interface View {
  letter: number; // letter index being auctioned
  rack: Rack; // my rack
  balance: number;
  score: number;
  rivals: Rival[];
  unseen: Int16Array; // unseen tile counts (bag + hidden opp starters), current letter excluded
  futureAuctions: number; // auctions after this one (bagTotal at open)
  totalAuctions: number; // auctions in a full match (~68)
  auctionsDone: number;
  myWins: number;
  firstPrice: boolean;
  prices: number[]; // observed paid prices this match (winner present)
  vHist: number[]; // my recent letter values this match
}

// Deterministic-ish RNG
let seed = 0x9e3779b9 ^ Date.now();
function rnd(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
}

export function sampleFuture(unseen: Int16Array, k: number): Int8Array[] | Int8Array {
  const pool: number[] = [];
  for (let L = 0; L < 26; L++) for (let i = 0; i < unseen[L]; i++) pool.push(L);
  const f = new Int8Array(26);
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (pool.length - i));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
    f[pool[i]]++;
  }
  return f;
}

export function futuresK(v: View): number {
  const R = v.futureAuctions;
  if (R <= 0) return 0;
  const seats = v.rivals.length + 1;
  const winRate = (v.myWins + 1.5) / (v.auctionsDone + seats * 1.5);
  const expWins = winRate * R;
  return Math.max(0, Math.min(Math.round(1.07 * expWins), 13, R));
}

export class Sampler {
  futures: Int8Array[] = [];
  sumWith = 0;
  sumWithout = 0;
  n = 0;
  constructor(public view: View, public k: number) {}
  // run `count` more CRN samples
  step(count: number) {
    const { rack, letter, unseen } = this.view;
    const tmp = new Int8Array(26);
    for (let s = 0; s < count; s++) {
      const f = this.k > 0 ? (sampleFuture(unseen, this.k) as Int8Array) : new Int8Array(26);
      this.futures.push(f);
      for (let L = 0; L < 26; L++) tmp[L] = rack[L] + f[L];
      const without = partitionValue(tmp, 6);
      tmp[letter]++;
      const withL = partitionValue(tmp, 6);
      this.sumWith += withL;
      this.sumWithout += without;
      this.n++;
    }
  }
  value(): number {
    return this.n ? (this.sumWith - this.sumWithout) / this.n : 0;
  }
  ep(): number {
    return this.n ? this.sumWithout / this.n : 0;
  }
}

const PRIOR_PRICES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12];

// Solve lambda (points per coin) so that expected future spend ~= budget.
export function solveLambda(v: View, curValue: number, ep: number): number {
  const R = v.futureAuctions + 1;
  const budget = v.balance + 0.47 * ep * (v.futureAuctions / Math.max(1, v.totalAuctions));
  const vs = v.vHist.length >= 6 ? v.vHist.slice(-30) : [...v.vHist, curValue, 3, 2, 5, 1, 6, 0, 4];
  const ps = v.prices.length >= 8 ? v.prices.slice(-40) : [...v.prices, ...PRIOR_PRICES];
  // paid = runner-up bid; the bid we must beat (top rival) is higher.
  const PREM = Number(process.env.TOP_PREMIUM ?? 1.25);
  const spend = (lam: number) => {
    let tot = 0;
    for (const x of vs) {
      const b = (1.14 * x) / lam;
      for (const p of ps) if (b > p * PREM + 1) tot += p;
    }
    return (R * tot) / (vs.length * ps.length);
  };
  let lo = Math.log(0.02);
  let hi = Math.log(4);
  if (spend(Math.exp(lo)) <= budget) return 0.02;
  if (spend(Math.exp(hi)) >= budget) return 4;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (spend(Math.exp(mid)) > budget) lo = mid;
    else hi = mid;
  }
  let lam = Math.exp((lo + hi) / 2) * 1.08;
  if (v.rivals.length + 1 >= 7) lam *= 0.8;
  return lam;
}

function simMaxBid(r: Rival, letter: number): number {
  const fv = LETTER_VALUE[letter];
  let base = fv;
  if (r.sim === "Cheapskate") base = fv - 1;
  else if (r.sim === "Aggressive") base = fv + (VOWEL.has(letter) ? 4 : 2);
  return Math.max(1, Math.min(base + 2, r.balance));
}

export function rivalCap(v: View): number {
  let cap = 0;
  for (const r of v.rivals) {
    const m = r.sim ? simMaxBid(r, v.letter) : r.balance;
    if (m > cap) cap = m;
  }
  return cap;
}

export function chooseBid(v: View, value: number, lam: number): number {
  if (v.balance <= 0 || value <= 0) return 0;
  let truthful = value / lam;
  let bid: number;
  if (v.firstPrice) {
    // maximize (truthful - b) * P(maxRival < b) using observed prices
    const ps = v.prices.length >= 8 ? v.prices.slice(-40) : [...v.prices, ...PRIOR_PRICES];
    let best = 0;
    let bestU = 0;
    const top = Math.min(Math.floor(truthful), v.balance);
    for (let b = 1; b <= top; b++) {
      let w = 0;
      for (const p of ps) if (p < b) w++;
      const u = (truthful - b) * (w / ps.length);
      if (u > bestU) {
        bestU = u;
        best = b;
      }
    }
    bid = best;
  } else {
    bid = Math.round(truthful);
  }
  const cap = rivalCap(v) + 1;
  bid = Math.min(bid, cap, v.balance);
  return Math.max(0, bid);
}

// Decide whether to play a word now. Returns the word or null.
export function playOrHold(
  rack: Rack,
  unseen: Int16Array,
  k: number,
  lam: number,
  samples: number,
  final: boolean,
): string[] | null {
  if (final) {
    const bp = bestPartition(rack);
    return bp.words.length ? bp.words : null;
  }
  const cands = formable(rack, 2);
  if (!cands.length) return null;
  cands.sort((a, b) => b.reward - a.reward);
  const top = cands.slice(0, 6);
  const futures: Int8Array[] = [];
  for (let s = 0; s < samples; s++) futures.push(k > 0 ? (sampleFuture(unseen, k) as Int8Array) : new Int8Array(26));
  const tmp = new Int8Array(26);
  let hold = 0;
  for (const f of futures) {
    for (let L = 0; L < 26; L++) tmp[L] = rack[L] + f[L];
    hold += partitionValue(tmp, 6);
  }
  hold /= futures.length;
  let bestW: string | null = null;
  let bestGain = 2.7;
  for (const c of top) {
    let play = 0;
    for (const f of futures) {
      for (let L = 0; L < 26; L++) tmp[L] = rack[L] + f[L];
      for (let i = 0; i < c.word.length; i++) tmp[c.word.charCodeAt(i) - 65]--;
      play += partitionValue(tmp, 6);
    }
    play = play / futures.length + c.reward * (1 + 0.32 * lam);
    const gain = play - hold;
    if (gain > bestGain) {
      bestGain = gain;
      bestW = c.word;
    }
  }
  return bestW ? [bestW] : null;
}

export function fullBag(): Int16Array {
  return Int16Array.from(BAG_COUNTS);
}

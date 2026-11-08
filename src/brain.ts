// Decision engine: Monte Carlo letter value, coin shadow price (lambda),
// bid choice, play/hold. Original implementation for the SCRBBEL bot.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BAG_COUNTS, LETTER_VALUE, VOWEL, partitionValue, formable, bestPartition, type Rack } from "./words.js";

// Tunable parameters (overridable via PARAMS_JSON env or setParams()).
export const P = {
  kMult: 1.07, // future tiles = kMult * expected wins
  kMax: 13,
  incomeFrac: 0.47, // expected word income counted into budget
  spendMult: 1.14, // bid scale used in spend model
  lamMult: 1.08,
  bigTableLam: 0.8, // lambda scale at 7+ seats
    holdMargin: 2.7, // play word only if it beats holding by this
  coinBonus: 0.32, // value of reward as coins (x lambda)
  fpShade: 1, // first-price: 1 = optimize vs prices
  partTopN: 6,
  drainFrac: 0.7, // heads-up / small tables: bid >= drainFrac * median price
  drainSeats: 3, // apply drain when seats <= this
  drainMinBal: 15,
  topAdd: 4, // winner bid ~ paid + topAdd
  fpTopAdd: 0,
  kBudget: 0, // k >= kBudget*balance/medianPrice (0 = off)
  affordK: 1, // k <= balance/medianPrice + affordK (0 = off)
  maxFrac: 0.35, // max share of balance on one tile while > paceLeft auctions remain (1 = off)
  paceLeft: 15,
  earlyCap: 0, // max coins spent in first third (0 = off)
  earlyShade: 0, // subtract from bids in first third
  vowelBonus: 0, // points added to a vowel's value when rack vowel share < vowelTarget
  vowelTarget: 0.4,
  marketWeight: 1, // weight of scouted market prior vs observed (all-real tables)
  denySeats: 99, // add rival-denial value (vs score leader) when seats <= this
  denyW: 0.6, // weight on rival's marginal value
  huLam: 1.0, // lambda multiplier (replaces lamMult) at <= denySeats seats
  denySamples: 16,
};
export function setParams(o: Partial<typeof P>) {
  Object.assign(P, o);
}
if (process.env.PARAMS_JSON) {
  try {
    setParams(JSON.parse(process.env.PARAMS_JSON));
  } catch {}
}

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
  rivalRacks?: Int8Array[]; // known tiles held by each rival (same order as rivals)
  rivalHidden?: number[]; // unrevealed starting tiles per rival
  mySpent?: number; // coins paid for tiles so far this match
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
  let k = Math.max(0, Math.min(Math.round(P.kMult * expWins), P.kMax, R));
  // Only count tiles we can afford: balance / typical clearing price (+1 for income).
  if (P.affordK > 0) {
    const th = thresholds(v, v.letter).slice().sort((a, b) => a - b);
    const med = Math.max(1, th[th.length >> 1] ?? 10);
    const afford = Math.floor(v.balance / med) + P.affordK;
    k = Math.min(k, afford);
    // Budget-driven floor: if we can afford more tiles than our win history suggests, plan to buy them.
    if (P.kBudget > 0) k = Math.max(k, Math.min(Math.floor((P.kBudget * v.balance) / med), R, P.kMax));
  }
  return k;
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
      const without = partitionValue(tmp, P.partTopN);
      tmp[letter]++;
      const withL = partitionValue(tmp, P.partTopN);
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

// Scouted market: top rival bid quantiles by letter group and phase.
type Q = { p25: number; p50: number; p75: number; p90: number };
let MARKET: Record<string, Q> = {};
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  MARKET = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "market.json"), "utf8")).top_bid_by_group_phase;
} catch {}
function group(L: number): string {
  const f = LETTER_VALUE[L];
  return f <= 1 ? "1" : f <= 3 ? "2-3" : f <= 5 ? "4-5" : "8-10";
}
function phase(v: View): string {
  const done = v.totalAuctions - v.futureAuctions;
  const fr = done / Math.max(1, v.totalAuctions);
  return fr < 1 / 3 ? "early" : fr < 2 / 3 ? "mid" : "late";
}
function marketQuantiles(L: number, ph: string): number[] | null {
  const q = MARKET[`${group(L)}|${ph}`];
  if (!q) return null;
  // rough 8-point distribution from quantiles
  return [q.p25 * 0.85, q.p25, (q.p25 + q.p50) / 2, q.p50, (q.p50 + q.p75) / 2, q.p75, q.p90, q.p90 * 1.15];
}
// Thresholds (bid needed to beat all rivals) for a given letter.
export function thresholds(v: View, L: number): number[] {
  const allReal = v.rivals.length > 0 && v.rivals.every((r) => !r.sim);
  // Vickrey: paid = runner-up bid, winner was higher. First-price: paid = winning bid.
  const add = v.firstPrice ? P.fpTopAdd : P.topAdd;
  const obs = v.prices.slice(-30).map((p) => p + add);
  const mk = allReal && P.marketWeight > 0 ? marketQuantiles(L, phase(v)) : null;
  if (mk && obs.length < 10) return [...mk, ...obs];
  if (mk) {
    const reps = Math.max(1, Math.round(P.marketWeight * 2));
    const out = [...obs];
    for (let i = 0; i < reps; i++) out.push(...mk);
    return out;
  }
  return obs.length >= 6 ? obs : [...obs, ...PRIOR_PRICES];
}

// Solve lambda (points per coin) so that expected future spend ~= budget.
export function solveLambda(v: View, curValue: number, ep: number): number {
  const R = v.futureAuctions + 1;
  const budget = v.balance + P.incomeFrac * ep * (v.futureAuctions / Math.max(1, v.totalAuctions));
  const vs = v.vHist.length >= 6 ? v.vHist.slice(-30) : [...v.vHist, curValue, 3, 2, 5, 1, 6, 0, 4];
  // thresholds for a typical future letter, weighted by the unseen pool
  const ps: number[] = [];
  for (let L = 0; L < 26; L++) {
    const n = v.unseen[L];
    if (n <= 0) continue;
    const th = thresholds(v, L);
    for (let i = 0; i < Math.min(n, 4); i++) ps.push(...th);
  }
  if (!ps.length) ps.push(...PRIOR_PRICES);
  const spend = (lam: number) => {
    let tot = 0;
    for (const x of vs) {
      const b = (P.spendMult * x) / lam;
      for (const p of ps) if (b > p) tot += p;
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
  let lam = Math.exp((lo + hi) / 2) * P.lamMult;
  if (v.rivals.length + 1 >= 7) lam *= P.bigTableLam;
  if (v.rivals.length + 1 <= P.denySeats) lam = (lam / P.lamMult) * P.huLam;
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

// Marginal value of the current letter to rival i (heads-up denial).
export function rivalValue(v: View, i: number, samples: number): number {
  if (!v.rivalRacks || !v.rivalRacks[i]) return 0;
  const hidden = v.rivalHidden?.[i] ?? 0;
  const seats = v.rivals.length + 1;
  const kr = Math.max(0, Math.min(Math.round((v.futureAuctions - 1) / seats), P.kMax));
  const rv: View = { ...v, rack: v.rivalRacks[i] };
  const s = new Sampler(rv, hidden + kr);
  s.step(samples);
  return Math.max(0, s.value());
}

export function chooseBid(v: View, value: number, lam: number): number {
  if (v.rivals.length + 1 <= P.denySeats && v.rivalRacks && v.futureAuctions > 0) {
    // deny the strongest rival (highest score; ties -> most balance)
    let bi = 0;
    for (let i = 1; i < v.rivals.length; i++) {
      const a = v.rivals[i], b = v.rivals[bi];
      if (a.score > b.score || (a.score === b.score && a.balance > b.balance)) bi = i;
    }
    value += P.denyW * rivalValue(v, bi, P.denySamples);
  }
  if (P.vowelBonus > 0 && VOWEL.has(v.letter)) {
    let tot = 0, vow = 0;
    for (let L = 0; L < 26; L++) { tot += v.rack[L]; if (VOWEL.has(L)) vow += v.rack[L]; }
    if (tot === 0 || vow / tot < P.vowelTarget) value += P.vowelBonus;
  }
  if (v.balance <= 0 || value <= 0) return 0;
  let truthful = value / lam;
  let bid: number;
  if (v.firstPrice) {
    // maximize (truthful - b) * P(maxRival < b) using observed prices
    const ps = thresholds(v, v.letter);
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
  // Small tables: price-drain floor so rivals overpay for what they win.
  const seats = v.rivals.length + 1;
  if (!v.firstPrice && seats <= P.drainSeats && v.balance >= P.drainMinBal && v.futureAuctions > 1) {
    const ps = v.prices.length >= 5 ? v.prices.slice(-25) : [...v.prices, ...PRIOR_PRICES];
    const sorted = [...ps].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    bid = Math.max(bid, Math.floor(P.drainFrac * med));
  }
  const cap = rivalCap(v) + 1;
  bid = Math.min(bid, cap, v.balance);
  if (v.futureAuctions > P.paceLeft) bid = Math.min(bid, Math.max(1, Math.floor(v.balance * P.maxFrac)));
  const early = v.totalAuctions - v.futureAuctions < v.totalAuctions / 3;
  if (early && P.earlyShade > 0) bid = Math.max(0, bid - P.earlyShade);
  if (early && P.earlyCap > 0 && v.mySpent !== undefined) bid = Math.min(bid, Math.max(0, P.earlyCap - v.mySpent));
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
  let bestGain = P.holdMargin;
  for (const c of top) {
    let play = 0;
    for (const f of futures) {
      for (let L = 0; L < 26; L++) tmp[L] = rack[L] + f[L];
      for (let i = 0; i < c.word.length; i++) tmp[c.word.charCodeAt(i) - 65]--;
      play += partitionValue(tmp, 6);
    }
    play = play / futures.length + c.reward * (1 + P.coinBonus * lam);
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

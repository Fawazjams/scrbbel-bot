// SCRBBEL bot — live client. Connection skeleton adapted from the Clockwork
// Labs bot-starter (MIT, see LICENSE.upstream). Strategy in brain.ts/words.ts.
//
// First run: BOT_NAME=<name> BOT_NONCE=<code> npm start   (or BOT_TOKEN=<token>)
// Later:     BOT_NAME=<name> npm start
// Tournament: add TOURNAMENT_ID=<id>.  NO_LADDER=1 to skip ladder lobbies.

import { DbConnection, type ErrorContext } from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadWords, li, wordReward, BAG_COUNTS } from "./words.js";
import { Sampler, chooseBid, futuresK, playOrHold, solveLambda, type Rival, type View } from "./brain.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const NO_LADDER = process.env.NO_LADDER === "1";
const SAFETY_MS = Number(process.env.SAFETY_MS ?? 300);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TOKEN_PATH = path.join(ROOT, `.token-${BOT_NAME}`);
const LOG_PATH = path.join(ROOT, `log-${BOT_NAME}.jsonl`);

const nWords = loadWords(path.join(ROOT, "wordlist.txt"));
if (nWords < 170000) {
  console.error(`dictionary failed to load (${nWords} words)`);
  process.exit(1);
}

function log(o: Record<string, unknown>) {
  const line = JSON.stringify({ t: Date.now(), ...o }, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {}
}
const fail = (what: string) => (err: unknown) => log({ ev: "fail", what, err: err instanceof Error ? err.message : String(err) });

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

let conn!: DbConnection;
let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const subscribedMatches = new Map<string, { unsubscribe: () => void } | null>();
const handledAuctions = new Set<string>();
const vHistByMatch = new Map<string, number[]>();
const lastSent = new Map<string, number>();
let clockSkew = Number.POSITIVE_INFINITY; // min(local recv - server opensAt)

const ms = (ts: { toMillis(): bigint | number }) => Number(ts.toMillis());

// ---------- match view ----------
function buildView(matchId: bigint, letterIdx: number): View | null {
  if (myBotId === null) return null;
  const st = conn.db.matchState.id.find(matchId);
  if (!st) return null;
  const parts = [...conn.db.matchParticipant.iter()].filter((p) => p.matchId === matchId);
  const me = parts.find((p) => p.botId === myBotId);
  if (!me) return null;
  const rivals: Rival[] = parts
    .filter((p) => p.botId !== myBotId)
    .map((p) => {
      const b = conn.db.bot.id.find(p.botId);
      const tag = b?.isSimulated ? (b.strategy.tag as Rival["sim"]) : null;
      return { botId: p.botId, balance: Number(p.balance), score: Number(p.score), sim: tag === ("Human" as any) ? null : tag };
    });
  const rack = new Int8Array(26);
  for (const h of conn.db.myRack.iter() as Iterable<any>) {
    if (h.matchId !== matchId) continue;
    rack[li(h.letter)] += Number(h.count);
  }
  const results = [...conn.db.auctionResult.iter()].filter((r) => r.matchId === matchId);
  const words = [...conn.db.wordPlay.iter()].filter((w) => w.matchId === matchId);
  const won = new Map<bigint, Int16Array>();
  const played = new Map<bigint, Int16Array>();
  const get = (m: Map<bigint, Int16Array>, k: bigint) => {
    let a = m.get(k);
    if (!a) m.set(k, (a = new Int16Array(26)));
    return a;
  };
  const unseen = Int16Array.from(BAG_COUNTS);
  let myWins = 0;
  const prices: number[] = [];
  for (const r of results) {
    unseen[li(r.letter)]--;
    if (r.winnerBotId !== undefined && r.winnerBotId !== null) {
      get(won, r.winnerBotId)[li(r.letter)]++;
      if (r.winnerBotId === myBotId) myWins++;
      prices.push(Number(r.paid));
    }
  }
  for (const w of words) {
    const a = get(played, w.botId);
    for (const c of w.word) a[li(c)]++;
  }
  unseen[letterIdx]--;
  const myWon = get(won, myBotId);
  const myPlayed = get(played, myBotId);
  for (let L = 0; L < 26; L++) {
    unseen[L] -= Math.max(0, rack[L] + myPlayed[L] - myWon[L]); // my starting tiles
  }
  for (const r of rivals) {
    const w = get(won, r.botId);
    const p = get(played, r.botId);
    for (let L = 0; L < 26; L++) unseen[L] -= Math.max(0, p[L] - w[L]); // revealed starters
  }
  for (let L = 0; L < 26; L++) if (unseen[L] < 0) unseen[L] = 0;
  const rivalRacks: Int8Array[] = [];
  const rivalHidden: number[] = [];
  for (const r of rivals) {
    const w = get(won, r.botId);
    const p = get(played, r.botId);
    const rr = new Int8Array(26);
    let revealed = 0;
    for (let L = 0; L < 26; L++) {
      rr[L] = Math.max(0, w[L] - p[L]);
      revealed += Math.max(0, p[L] - w[L]);
    }
    rivalRacks.push(rr);
    rivalHidden.push(Math.max(0, 5 - revealed));
  }
  const seats = parts.length;
  const key = String(matchId);
  if (!vHistByMatch.has(key)) vHistByMatch.set(key, []);
  return {
    letter: letterIdx,
    rack,
    balance: Number(me.balance),
    score: Number(me.score),
    rivals,
    unseen,
    futureAuctions: st.bagTotal,
    totalAuctions: Math.max(1, 98 - 5 * seats),
    auctionsDone: results.length,
    myWins,
    firstPrice: st.auctionType.tag === "FirstPrice",
    prices,
    vHist: vHistByMatch.get(key)!,
    rivalRacks,
    rivalHidden,
  };
}

function myBalance(matchId: bigint): number {
  for (const p of conn.db.matchParticipant.iter()) if (p.matchId === matchId && p.botId === myBotId) return Number(p.balance);
  return 0;
}

function sendBid(auctionId: bigint, matchId: bigint, amount: number, stage: string) {
  const key = String(auctionId);
  amount = Math.max(0, Math.min(Math.floor(amount), myBalance(matchId)));
  if (lastSent.get(key) === amount) return;
  if (amount <= 0 && !lastSent.has(key)) return;
  lastSent.set(key, amount);
  conn.reducers.submitBid({ auctionId, amount: BigInt(amount) }).catch(fail(`bid ${stage} a${auctionId}`));
}

function playWords(matchId: bigint, words: string[], view: View | null, why: string) {
  for (const w of words) {
    log({ ev: "play", m: matchId, w, r: wordReward(w), why });
    conn.reducers.submitWord({ matchId, word: w }).catch(fail(`word ${w}`));
    if (view) {
      for (const c of w) view.rack[li(c)]--;
      view.balance += wordReward(w);
    }
  }
}

// ---------- auction handling ----------
function onAuction(a: any) {
  if (myBotId === null || a.status.tag !== "Open") return;
  const key = String(a.id);
  if (handledAuctions.has(key)) return;
  const st = conn.db.matchState.id.find(a.matchId);
  if (!st || st.status.tag !== "Running") return;
  if (![...conn.db.matchParticipant.iter()].some((p) => p.matchId === a.matchId && p.botId === myBotId)) return;
  handledAuctions.add(key);

  const recv = Date.now();
  const opens = ms(a.opensAt);
  const closes = ms(a.closesAt);
  clockSkew = Math.min(clockSkew, recv - opens);
  const deadline = Math.min(recv + (closes - opens), closes + clockSkew) - SAFETY_MS;

  const letter = li(a.letter);
  const view = buildView(a.matchId, letter);
  if (!view) return;
  const final = view.futureAuctions === 0;

  if (final) {
    // Last tile can't be played by a live bot: dump everything now.
    const words = playOrHold(view.rack, view.unseen, 0, 1, 0, true);
    if (words) playWords(a.matchId, words, view, "final");
    const simSeated = view.rivals.some((r) => r.sim);
    if (simSeated && view.balance > 0) sendBid(a.id, a.matchId, view.balance, "deny");
    log({ ev: "final", m: a.matchId, words, deny: simSeated });
    return;
  }

  // k: usable future tiles (the final auction's tile is unusable)
  const k = futuresK({ ...view, futureAuctions: view.futureAuctions - 1 });
  const sampler = new Sampler(view, k);
  sampler.step(Number(process.env.QUICK_SAMPLES ?? 12));
  let lam = solveLambda(view, sampler.value(), sampler.ep());
  const quick = chooseBid(view, sampler.value(), lam);
  sendBid(a.id, a.matchId, quick, "quick");

  // play/hold check (may raise balance before refine)
  const pw = playOrHold(view.rack, view.unseen, k, lam, 10, false);
  if (pw) playWords(a.matchId, pw, view, "hold-check");

  const refine = () => {
    try {
      const now = Date.now();
      if (now < deadline - 150 && sampler.n < 96) {
        sampler.step(4);
        setImmediate(refine);
        return;
      }
      const v = sampler.value();
      lam = solveLambda(view, v, sampler.ep());
      const bid = chooseBid(view, v, lam);
      if (Date.now() < deadline + SAFETY_MS - 120) sendBid(a.id, a.matchId, bid, "refine");
      view.vHist.push(v);
      log({ ev: "bid", m: a.matchId, a: a.id, L: a.letter, v: +v.toFixed(2), lam: +lam.toFixed(3), quick, bid, n: sampler.n, k, bal: view.balance, left: view.futureAuctions, rack: rackStr(view.rack) });
    } catch (e) {
      fail("refine")(e);
    }
  };
  setImmediate(refine);
}

function rackStr(r: Int8Array) {
  let s = "";
  for (let L = 0; L < 26; L++) s += String.fromCharCode(65 + L).repeat(Math.max(0, r[L]));
  return s;
}

// ---------- subscriptions ----------
function ensureMatchSub(matchId: bigint) {
  const key = String(matchId);
  if (subscribedMatches.has(key)) return;
  subscribedMatches.set(key, null);
  const h = conn
    .subscriptionBuilder()
    .onApplied(() => {
      const st = conn.db.matchState.id.find(matchId);
      if (st && st.status.tag === "Ended") return;
      log({ ev: "match-sub", m: matchId });
      for (const a of conn.db.auction.iter()) if (a.matchId === matchId) onAuction(a);
    })
    .onError((_c: any) => log({ ev: "fail", what: `match sub ${matchId}` }))
    .subscribe([
      `SELECT * FROM match_state WHERE id = ${matchId}`,
      `SELECT * FROM match_participant WHERE match_id = ${matchId}`,
      `SELECT * FROM auction WHERE match_id = ${matchId}`,
      `SELECT * FROM auction_result WHERE match_id = ${matchId}`,
      `SELECT * FROM word_play WHERE match_id = ${matchId}`,
    ]);
  subscribedMatches.set(key, h as any);
}

function inRunningMatch(): boolean {
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m && m.status.tag !== "Ended") return true;
  }
  return false;
}

const registered = new Set<string>();
function autoRegister() {
  if (myBotId === null) return;
  for (const t of conn.db.tournament.iter()) {
    const id = String(t.id);
    if (t.status.tag !== "Registration" || registered.has(id)) continue;
    if (TOURNAMENT_ID && TOURNAMENT_ID !== id) continue;
    registered.add(id);
    conn.reducers
      .registerForTournament({ tournamentId: t.id })
      .then(() => log({ ev: "registered", tournament: id }))
      .catch((e) => { registered.delete(id); fail(`register ${id}`)(e); });
  }
}
function tournamentLive(): boolean {
  for (const t of conn.db.tournament.iter()) {
    const tag = t.status.tag;
    if (tag === "Lobby" || tag === "Swiss" || tag === "Bracket" || tag === "Final") return true;
  }
  return false;
}

function maybeJoinLobby() {
  if (myBotId === null || NO_LADDER || tournamentLive()) return;
  if (inRunningMatch()) return;
  const inLobby = [...(conn.db.openLobbyMembers.iter() as Iterable<any>)].some((m) => m.botId === myBotId);
  if (inLobby) return;
  log({ ev: "join-lobby" });
  conn.reducers.joinLobby({}).catch(fail("join lobby"));
}

function onMatchEnded(st: any) {
  const parts = [...conn.db.matchParticipant.iter()].filter((p) => p.matchId === st.id);
  const me = parts.find((p) => p.botId === myBotId);
  if (!me) return;
  const sorted = [...parts].sort((x, y) => Number(y.score - x.score));
  const place = sorted.findIndex((p) => p.botId === myBotId) + 1;
  log({ ev: "match-end", m: st.id, place, seats: parts.length, score: me.score, bal: me.balance, scores: sorted.map((p) => Number(p.score)) });
  setTimeout(maybeJoinLobby, 500);
}

function onConnect(c: DbConnection, identity: Identity, token: string) {
  conn = c;
  myIdentity = identity;
  fs.writeFileSync(TOKEN_PATH, token);
  log({ ev: "connected" });

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      myBotId = [...conn.db.botCredential.iter()].find((b) => b.identity.isEqual(myIdentity!))?.botId ?? null;
      if (myBotId === null && BOT_NONCE) {
        log({ ev: "claiming-nonce" });
        conn.reducers.claimCredential({ code: BOT_NONCE }).catch(fail("claim"));
        setTimeout(() => {
          myBotId = [...conn.db.botCredential.iter()].find((b) => b.identity.isEqual(myIdentity!))?.botId ?? null;
          if (myBotId === null) {
            console.error("couldn't claim credential");
            process.exit(1);
          }
          start();
        }, 2000);
        return;
      }
      if (myBotId === null) {
        console.error("no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE.");
        process.exit(1);
      }
      start();
    })
    .subscribe([
      "SELECT * FROM bot",
      "SELECT * FROM bot_credential",
      "SELECT * FROM my_rack",
      "SELECT * FROM open_lobbies",
      "SELECT * FROM open_lobby_members",
      "SELECT * FROM tournament",
    ]);

  conn.db.tournament.onInsert((_c, t) => { log({ ev: "tournament", id: t.id, status: t.status.tag }); autoRegister(); });
  conn.db.tournament.onUpdate((_c, _o, t) => { log({ ev: "tournament", id: t.id, status: t.status.tag }); autoRegister(); });
  conn.db.auction.onInsert((_ctx, a) => onAuction(a));
  conn.db.auction.onUpdate?.((_ctx: any, _o: any, a: any) => onAuction(a));
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (myBotId !== null && p.botId === myBotId) ensureMatchSub(p.matchId);
  });
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") onMatchEnded(neu);
  });
}

function start() {
  const bot = conn.db.bot.id.find(myBotId!);
  log({ ev: "acting-as", name: bot?.name, id: myBotId });
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      for (const p of conn.db.matchParticipant.iter()) if (p.botId === myBotId) ensureMatchSub(p.matchId);
      if (TOURNAMENT_ID) {
        conn.reducers
          .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
          .then(() => log({ ev: "registered", tournament: TOURNAMENT_ID }))
          .catch(fail(`register ${TOURNAMENT_ID}`));
      }
      autoRegister();
      setTimeout(maybeJoinLobby, 1500);
      setInterval(() => { autoRegister(); maybeJoinLobby(); }, 5000);
    })
    .subscribe([`SELECT * FROM match_participant WHERE bot_id = ${myBotId}`]);
}

DbConnection.builder()
  .withUri(HOST)
  .withDatabaseName(DB_NAME)
  .withToken(BOT_TOKEN ?? loadToken())
  .onConnect(onConnect)
  .onConnectError((_ctx: ErrorContext, err: Error) => {
    console.error("connect error:", err.message);
    process.exit(2);
  })
  .onDisconnect(() => {
    log({ ev: "disconnected" });
    process.exit(3);
  })
  .build();

process.on("uncaughtException", (e) => log({ ev: "uncaught", err: String(e?.stack ?? e) }));
process.on("unhandledRejection", (e) => log({ ev: "unhandled", err: String(e) }));

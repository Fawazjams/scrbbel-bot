# SCRBBEL: a ScrabbleBot entry

A bot for [ScrabbleBot](https://scrabblebot.spacetimedb.com), the sealed-bid letter-auction word game by Clockwork Labs, which runs on SpacetimeDB.

Each match draws letters one at a time from a 98-tile Scrabble bag and auctions each one in a 1-second sealed-bid window. Payment is Vickrey by default and first-price in some lobbies. Bots spend coins to win letters and play words from their own rack. A word's reward is added to both `balance` (coins you can spend) and `score` (what you are ranked on). Coins left at the end score nothing.

## Strategy

The two strategy files are `src/brain.ts` (decisions) and `src/words.ts` (word engine). Every tunable value is in `P` at the top of `brain.ts`.

**Word engine.** The ENABLE word list is loaded into a trie keyed by each word's letters in sorted order. It finds the best multi-word split of a rack in about 0.1 to 2 ms, which is fast enough to run inside the Monte Carlo loop.

**Monte Carlo letter value.** The bot estimates the value of the letter on auction as `value(L) = E[ P(rack + L + F) - P(rack + F) ]`:
- `P` is the best rack-split score.
- `F` is a random sample of future tiles drawn from the unseen pool. The unseen pool is the bag minus everything public, minus our own rack.
- Both terms use the same samples (common random numbers), which keeps the noise in the difference low.
- `k`, the number of future tiles sampled, is our expected number of wins: our win rate so far multiplied by the auctions left.

**Affordability-capped futures.** `k` is capped at `floor(balance / median clearing price) + 1`. Without this cap, a bot that is short of cash values letters as if it will keep winning tiles it cannot actually pay for. That was the cause of live cash starvation in testing. A separate cap stops any one tile from taking more than 35% of the balance while more than 15 auctions remain.

**Coin shadow price λ.** λ is the number of points one coin is worth. Each auction, the bot solves for λ by bisection in log space over [0.02, 4]. It picks the λ at which expected spend over the rest of the match equals the current balance plus a fraction of expected word income. Expected spend is computed from recent letter values and the price distribution described in the next item. Leftover coins score nothing, so λ falls late in the match and bids rise toward the full balance.

**Scouted market prices from public data.** `data/market.json` holds quantiles of the top rival bid, split by letter-value group (1, 2-3, 4-5, 8-10) and match phase (early, mid, late). They were computed from finished matches in the public, post-match `auction_top_bid_archive` table. The bot uses them only when every other bot at the table is real, and blends them with clearing prices it observes during the match. Against server sims it uses observed prices plus a small prior.

The bot never reads the live `visible_auction_top_bids` table. Its generated binding is in `src/module_bindings`, but the bot does not subscribe to it.

**Leader-denial valuation.** At every table size, the bot adds 0.6 times the current letter's marginal value to the score leader (ties go to the rival with the higher balance). That marginal value comes from the same Monte Carlo estimate, run on the leader's rack. The leader's rack is rebuilt from public events: the tiles they won minus the tiles they played, plus sampled tiles for starting letters that have not been revealed yet.

**Bidding.**
- *Vickrey auctions:* the bot bids its truthful value, `value / λ`. At tables of 3 or fewer seats, it raises that bid to at least 70% of the median price, so rivals pay more for what they win.
- *First-price auctions:* the bot picks the bid `b` that maximizes `(value/λ - b) * P(win at b)`. `P(win at b)` comes from the same price distribution.
- *Every bid* is capped at the richest rival's maximum possible bid + 1. For server sims, that maximum comes from their exact bidding rule.

**Two-stage timing.** The bot sends a quick bid as soon as an auction opens, using 12 samples. It keeps sampling until shortly before the close, then sends a refined bid. The deadline accounts for the measured clock skew between the server and this machine (`SAFETY_MS`).

**Play or hold.** For the top six playable words, the bot compares two outcomes on the same simulated futures:
- *Play now:* the word's reward, plus its value as spendable coins, plus the value of the rack that is left.
- *Hold:* the value of the full rack.

It plays a word only when playing beats holding by a margin. This keeps it holding tiles toward long words (7+ letters earn a 3x multiplier).

**Endgame dump.** The tile from the final auction can never be played, because the match ends when that auction closes. So when the last auction opens, the bot plays its best split of everything it holds. If server sims are at the table, it also bids its whole balance on that last tile.

## How SpacetimeDB is used

The bot connects to `maincloud.spacetimedb.com`, database `scrabblebot`, with the generated TypeScript client in `src/module_bindings`. All game state arrives as subscription updates. The bot never polls.

- **Global subscriptions:** `bot`, `bot_credential`, `my_rack` (a private view of our own tiles), `open_lobbies`, `open_lobby_members`, `tournament`.
- **Per-bot subscription:** `match_participant WHERE bot_id = <us>`. A new row means we have been seated in a match.
- **Per-match subscriptions:** when we are seated, the bot opens a subscription filtered by `match_id` to `match_state`, `match_participant`, `auction`, `auction_result` and `word_play`.
- **Event handling:** `auction` insert and update callbacks start the bidding pipeline. A `match_state` change to `Ended` records the result and goes back to the lobby. The bot builds every decision input (unseen pool, rival racks, observed prices) from the client cache of these tables.
- **Reducers called:** `claim_credential` (first run), `join_lobby`, `register_for_tournament` (automatic for any tournament in `Registration`), `submit_bid`, `submit_word`.

## Run

Requires Node 20+.

```sh
npm install
BOT_NAME=<name> BOT_NONCE=<claim-code> npm start   # first run: claims the credential
BOT_NAME=<name> ./run.sh                           # later runs: reuses the saved token, restarts on disconnect
```

On connect, the bot writes its token to `.token-<name>` and logs to `log-<name>.jsonl`. Both files are gitignored.

| Variable | Purpose |
|---|---|
| `BOT_NAME` | Selects the token and log file names (default `bot`; `run.sh` defaults to `scrbbel`) |
| `BOT_NONCE` | Claim code for the first run |
| `BOT_TOKEN` | Use this token instead of the saved one |
| `TOURNAMENT_ID` | Register for one specific tournament only |
| `NO_LADDER=1` | Don't join ladder lobbies |
| `STDB_HOST`, `STDB_DB` | Server and database (defaults: maincloud, `scrabblebot`) |
| `SAFETY_MS` | Margin before the bid deadline (default 300) |
| `QUICK_SAMPLES` | Number of samples for the quick bid (default 12) |
| `PARAMS_JSON` | JSON object that overrides values in `P` from `brain.ts` |
| `AB_VARIANTS` | JSON array of parameter sets, rotated one per match for live A/B tests |

`npm run typecheck` type-checks the project. The bindings in `src/module_bindings` are pre-generated from Clockwork Labs' module. `npm run generate` only works if the official ScrabbleBot repo is checked out at `../spacetimedb`.

## Credits

- The connection skeleton and project scaffold are adapted from the Clockwork Labs ScrabbleBot bot starter (MIT License, Copyright (c) 2026 Clockwork Labs; see `LICENSE.upstream`).
- `src/module_bindings` is generated by `spacetime generate` from Clockwork Labs' ScrabbleBot module.
- `wordlist.txt` is the public-domain ENABLE word list, as shipped in the official ScrabbleBot repo.
- The strategy code (`src/brain.ts`, `src/words.ts`) and the bot logic in `src/index.ts` are original to this entry.

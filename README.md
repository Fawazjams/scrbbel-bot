# SCRBBEL — ScrabbleBot entry

A bot for [ScrabbleBot](https://scrabblebot.spacetimedb.com), the sealed-bid letter-auction word game by Clockwork Labs, built on SpacetimeDB.

## Strategy
- **Word engine** (`src/words.ts`): ENABLE word list in a sorted-letter-signature trie; best multi-word split of a rack in ~0.1–2 ms.
- **Letter value** (`src/brain.ts`): Monte Carlo over future draws from the unseen tile pool, with common random numbers: value(L) = E[P(rack+L+F) − P(rack+F)].
- **Coin pricing**: a shadow price λ (points per coin), solved by bisection each auction so expected spending matches balance plus expected word income. Leftover coins score nothing, so λ falls toward 0 late and bids rise to the full balance.
- **Bidding**: truthful Vickrey bid value/λ, shaded under first-price; capped at the richest rival's reach + 1 (exact sim-bot formula for server sims).
- **Two-stage timing**: quick bid the instant an auction opens, refined bid before the close.
- **Play or hold**: plays a word only when it beats holding on the same simulated futures (holds for 7+ letter, 3x words).
- **Endgame**: the last tile can't be played, so all words are dumped when the final auction opens.
- **Ops**: per-match subscriptions, tournament auto-registration, restart loop (`run.sh`).

## Run
```
npm install
BOT_NAME=<name> BOT_NONCE=<code> npm start   # first run; token saved to .token-<name>
./run.sh                                     # later runs, auto-restart
```

Connection skeleton adapted from the Clockwork Labs bot starter (MIT, see `LICENSE.upstream`).

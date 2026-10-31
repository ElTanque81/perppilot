# PerpPilot

**Trade dreamDEX perps from Telegram, and let a margin guard keep you out of liquidation.**

PerpPilot is a Telegram co-pilot for [dreamDEX](https://app.testnet.dreamdex.io) perpetuals on Somnia Tokyo (Hideki) testnet. You open and close positions with one chat command and one tap. You see PnL, liquidation price and margin health at a glance. A guard runs beside you and warns, trims or flattens before the protocol liquidates you.

Built for the **dreamDEX Perps Builder Bounty** (MVP track, category: bots and agents / trader tools).

## Who it is for

- **Perps Arena traders** who don't want to sit in front of the app all day. Check your book, cut risk or catch a move from your phone in seconds.
- **Anyone running leverage.** At 20x a 2.5% move is enough to liquidate a position. The guard watches health 24/7 and acts on rules you set.
- **Bot builders** who want a working, readable reference for trading-key mode, sizing, closing and health on dreamDEX perps.

## What it does

| Command | What happens |
|---|---|
| `/long BTC 50` · `/short ETH 25` | Opens or adds to a position worth 50 / 25 USDso with a market (IOC) order. Shows size and price first and only sends after you tap **Confirm**. |
| `/close BTC` · `/close BTC 50` · `/close ALL` | Closes all, a percentage, or every position. |
| `/pos` | Equity, free margin, **health** (equity ÷ maintenance, 1.00x = liquidation), and per position: entry, mark, uPnL, **liquidation price and its distance**. |
| `/price BTC` · `/markets` | Live on-chain mark and index, funding APR and who pays whom. |
| `/guard off\|alert\|auto` | **alert**: messages you when health drops into a worse band. **auto**: also trims 25% below 1.5x and closes everything below 1.15x. |
| `/alert BTC > 90000` | Price alert with one-tap trade suggestions when it fires. |
| `/trades` | Last orders with transaction hashes, which are also written to `trades.jsonl`. |
| `/status` | Network, bot-key link coverage, gas and margin check. |

### Why it is safe to hand a bot your account

- **Trading-key mode.** The bot signs with its own key, linked to your account with the app's **Link a bot**. That key can place, cancel and reduce orders, and it can **never withdraw or transfer funds**.
- **Only your chat.** Every message from any other Telegram chat is ignored.
- **Confirm before send.** Each order is previewed and needs a tap. Confirmations expire after 60 s because prices move.
- **Caps.** `MAX_NOTIONAL_USDSO` limits each order, and `SLIPPAGE_BPS` bounds the fill price.
- **Dry run by default.** Nothing is sent until you set `DRY_RUN=false`.

### Repeat-use loop

PerpPilot pings *you*: guard alerts when margin gets thin, and price alerts when a level breaks, each with the command to act on it. Traders come back because the bot brings them back at the moment it matters.

## How it works

```
Telegram ──► grammY bot (src/index.ts)
               │  confirm buttons, chat allow-list
               ▼
            Pilot (src/pilot.ts) ── sizing via getMaxPerpOrderSize
               │                    close via previewPerpClosePnl
               │                    IOC orders: placeOrderFor (trading key) or placePerpOrder
               ▼
   @somnia-chain/markets-sdk 0.32.1 ──► Somnia Tokyo testnet (chain 50383)
               ▲
            Guard (src/guard.ts) ── polls MarginBank health + live marks every 30 s
```

- Prices for sizing, triggers and alerts come from the **chain** (`getPerpHealthSnapshot`, `getPerpState`), not from the indexer row, which lags by tens of minutes.
- Writes share one key, so they go through a mutex. Without it, the guard and a chat order could race for the same nonce.
- `src/perp-core/` is vendored from the official [dreamDEX bot kit](https://github.com/somnia-chain/dreamdex-bot-kit) (MIT, © DreamDEX S.A., licence in that folder). It provides market lookup, sizing, margin snapshots and the trading-key `placeOrderFor` path.

## Run it

Requirements: Node.js 20+, a Telegram account, and a dreamDEX testnet account in Perps Arena (or one with USDso in its Perps account).

```bash
git clone https://github.com/ElTanque81/perppilot
cd perppilot
npm install
cp .env.example .env
```

1. **Telegram bot:** talk to [@BotFather](https://t.me/BotFather), `/newbot`, and paste the token as `TELEGRAM_BOT_TOKEN`.
2. **Bot key:** create a fresh wallet just for the bot (for example `cast wallet new`, or a new account in your wallet app) and put its private key in `PRIVATE_KEY`. Put your dreamDEX account address in `OWNER_ADDRESS`.
3. **Link it:** in the dreamDEX testnet app open your wallet → **Link a bot** → paste the bot key's address → keep **Perps** ticked → **Add bot**. Let the app send it some STT for gas.
4. **Margin:** on the perps page use **Perps ⇆ Spot** to make sure USDso sits in the Perps account.
5. `npm run doctor` checks everything read-only.
6. `npm start`, then message your bot. The first reply gives you your chat id. Put it in `TELEGRAM_CHAT_ID` and start again.
7. Try a dry run with `/long BTC 20` → Confirm. When it looks right, set `DRY_RUN=false` and restart.

> Never use your main wallet's key as `PRIVATE_KEY`. The linked bot key is the whole point: it can trade, but it cannot take your funds.

## Proof of live orders

Real orders sent by PerpPilot on Somnia Tokyo testnet (from `trades.jsonl`):

| Time (UTC) | Market | Action | Tx hash |
|---|---|---|---|
| _to fill in_ | | | |

## X posts

- _link 1_
- _link 2_
- _link 3_

## Roadmap

- Somnia **Reactivity** subscriptions instead of polling, so the guard reacts within a block.
- Natural-language orders ("short ETH with 50 bucks, stop at 2,500") through an LLM agent.
- Multi-user mode: each user links their own bot key and gets their own guard.
- TP/SL watched by the bot, with Stop orders armed on-chain when the bot trades its own account.

## Disclaimer

Testnet software for paper trading. Not financial advice. Use at your own risk.

## License

MIT. See [LICENSE](LICENSE). `src/perp-core/` © DreamDEX S.A., MIT.

// PerpPilot's trading core: every action the Telegram bot exposes, built on the
// dreamDEX bot kit's perp-core helpers (vendored in ./perp-core, MIT).
//
// Each write returns the transaction hash so it can be shown in chat and kept
// in the journal as evidence of a real order on Somnia Tokyo testnet.

import { formatUnits } from "viem";
import {
  ORDER_TYPE,
  alignPrice,
  createExchange,
  healthRatio,
  linkCoverage,
  liveFunding,
  liveMark,
  marginSnapshot,
  markOf,
  perpMarkets,
  placeFor,
  positionIn,
  requireMarket,
  sizeForNotional,
  sizeOrder,
  type MarginSnapshot,
  type PerpContext,
  type PerpMarket,
  type Side,
} from "./perp-core/index.js";
import { journal } from "./journal.js";

export interface OrderOutcome {
  ok: boolean;
  /** One line for the chat. */
  message: string;
  hash?: `0x${string}`;
  filled?: number;
  price?: number;
}

export interface PositionView {
  market: PerpMarket;
  side: Side;
  size: number;
  entry: number;
  mark?: number;
  uPnl?: number;
  liq?: number;
  notional: number;
  /** Distance from mark to liquidation, in percent of the mark. */
  liqDistancePct?: number;
}

export interface AccountView {
  account: `0x${string}`;
  snapshot?: MarginSnapshot;
  health: number;
  equity: number;
  free: number;
  positions: PositionView[];
}

/** Writes share one signing key, so they must not overlap (nonce races). */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class Pilot {
  readonly ctx: PerpContext;
  private readonly writes = new Mutex();

  constructor() {
    const dry = (process.env.DRY_RUN ?? "true").trim().toLowerCase() !== "false";
    this.ctx = createExchange({ withSigner: !dry });
  }

  get dryRun(): boolean {
    return this.ctx.config.dryRun;
  }

  /** The DreamDEX account the bot reads and trades: OWNER_ADDRESS in trading-key mode. */
  get account(): `0x${string}` | undefined {
    return this.ctx.exchange.walletAddress as `0x${string}` | undefined;
  }

  get mode(): string {
    if (this.ctx.tradingKey) return `trading key ${short(this.ctx.tradingKey.operator)} for ${short(this.ctx.tradingKey.owner)}`;
    if (this.account) return `own key ${short(this.account)}`;
    return "read-only";
  }

  markets(reload = true): Promise<PerpMarket[]> {
    return perpMarkets(this.ctx.exchange, reload);
  }

  market(symbol: string): Promise<PerpMarket> {
    return requireMarket(this.ctx.exchange, symbol, { reload: true, includeHalted: true });
  }

  async mark(market: PerpMarket): Promise<number | undefined> {
    return liveMark(this.ctx.exchange, market);
  }

  async funding(market: PerpMarket) {
    return liveFunding(this.ctx.exchange, market);
  }

  /** Startup self-check, one line per finding. */
  async selfCheck(): Promise<string[]> {
    const lines: string[] = [];
    const markets = await this.markets();
    lines.push(`network ${this.ctx.config.network} (chain ${this.ctx.config.chainId}), ${markets.length} live perp markets`);
    lines.push(`mode: ${this.mode}${this.dryRun ? " · DRY RUN (no orders are sent)" : " · LIVE"}`);
    if (this.ctx.tradingKey) {
      const { linked, missing } = await linkCoverage(this.ctx, markets);
      lines.push(
        missing.length === 0
          ? `link: ok on all ${linked.length} markets`
          : linked.length === 0
            ? `link: NOT linked. In the app open your wallet → Link a bot → tick Perps → paste ${this.ctx.tradingKey.operator}`
            : `link: ok on ${linked.length}/${markets.length}, missing ${missing.map((m) => m.display).join(", ")}`,
      );
      const gas = await this.ctx.tradingKey.publicClient.getBalance({ address: this.ctx.tradingKey.operator });
      lines.push(`bot key gas: ${Number(formatUnits(gas, 18)).toFixed(4)} STT`);
    }
    if (this.account) {
      const view = await this.accountView();
      lines.push(`margin: equity ${view.equity.toFixed(2)} USDso · free ${view.free.toFixed(2)} · health ${fmtHealth(view.health)}`);
      if (view.equity === 0) lines.push("empty Perps account: in the app open Perps ⇆ Spot and move USDso to the Perps account");
    }
    return lines;
  }

  async accountView(): Promise<AccountView> {
    const account = this.account;
    if (!account) throw new Error("No account configured: set PRIVATE_KEY (and OWNER_ADDRESS for a linked bot key).");
    const markets = await this.markets(true);
    const first = markets[0];
    if (!first) throw new Error("No live perp markets.");
    const snapshot = await marginSnapshot(this.ctx.exchange, first, account);
    const dp = first.info.quoteDecimals;
    const raw = await this.ctx.exchange.fetchPositions();
    const positions: PositionView[] = [];
    for (const p of raw) {
      const market = markets.find((m) => m.symbol === p.symbol) ?? (await this.market(p.symbol));
      const mark = (await this.mark(market)) ?? p.markPrice ?? markOf(market.info);
      const liq = p.liquidationPrice && p.liquidationPrice > 0 ? p.liquidationPrice : undefined;
      positions.push({
        market,
        side: p.side,
        size: p.contracts,
        entry: p.entryPrice,
        mark,
        uPnl: p.unrealizedPnl,
        liq,
        notional: p.contracts * (mark ?? 0),
        liqDistancePct: liq && mark ? (Math.abs(mark - liq) / mark) * 100 : undefined,
      });
    }
    return {
      account,
      snapshot,
      health: healthRatio(snapshot),
      equity: Number(snapshot.equity) / 10 ** dp,
      free: Number(snapshot.unlocked) / 10 ** dp,
      positions,
    };
  }

  /** Open or add to a position with a marketable (IOC) order sized by USDso notional. */
  async open(symbol: string, side: Side, notionalUsdso: number, source = "chat"): Promise<OrderOutcome> {
    const market = await this.market(symbol);
    const account = this.account;
    if (!account) return { ok: false, message: "read-only: no PRIVATE_KEY configured" };

    const book = await this.ctx.exchange.fetchOrderBook(market.symbol, 1);
    const touch = side === "long" ? book.asks[0]?.[0] : book.bids[0]?.[0];
    if (touch === undefined) return { ok: false, message: `${market.display}: nobody is quoting on the other side right now` };

    const mark = await this.mark(market);
    const price = BigInt(Math.round(touch * 1e18));
    const wanted = sizeForNotional(notionalUsdso, market.info, mark);
    const sized = await sizeOrder(this.ctx.exchange, {
      market,
      account,
      side,
      price,
      wanted,
      tradingKey: this.ctx.tradingKey,
    });
    if (!sized.ok) return { ok: false, message: `${market.display}: cannot open, ${sized.reason}` };

    return this.send(market, side, sized.quantity, price, `open ${side}`, source);
  }

  /** Close `fraction` (0..1] of the position in `symbol` with a marketable order. */
  async close(symbol: string, fraction = 1, source = "chat"): Promise<OrderOutcome> {
    const market = await this.market(symbol);
    const account = this.account;
    if (!account) return { ok: false, message: "read-only: no PRIVATE_KEY configured" };

    const preview = await this.ctx.exchange.client.previewPerpClosePnl({
      pool: market.info.poolAddress,
      marginBank: market.info.marginBank,
      account,
    });
    if (!preview.priceable) return { ok: false, message: `${market.display}: mark is stale, the close cannot be sized right now` };
    const whole = preview.closedQuantity;
    if (whole <= 0n) return { ok: false, message: `${market.display}: no open position` };

    const lot = BigInt(market.info.lotSize);
    const f = Math.min(1, Math.max(0, fraction));
    let quantity = f >= 1 ? whole : (whole * BigInt(Math.round(f * 10_000))) / 10_000n;
    if (lot > 0n) quantity = (quantity / lot) * lot;
    if (quantity < BigInt(market.info.minQuantity)) {
      return { ok: false, message: `${market.display}: ${Math.round(f * 100)}% is below the market minimum, close more of it` };
    }

    const position = await positionIn(this.ctx.exchange, market);
    if (!position) return { ok: false, message: `${market.display}: no open position` };
    const side: Side = position.side === "long" ? "short" : "long";
    const book = await this.ctx.exchange.fetchOrderBook(market.symbol, 1);
    const touch = side === "long" ? book.asks[0]?.[0] : book.bids[0]?.[0];
    if (touch === undefined) return { ok: false, message: `${market.display}: nobody is quoting on the other side right now` };

    const label = f >= 1 ? "close" : `reduce ${Math.round(f * 100)}%`;
    return this.send(market, side, quantity, BigInt(Math.round(touch * 1e18)), label, source);
  }

  /**
   * Send one immediate-or-cancel order. 30 bps of slippage room past the touch,
   * because an IOC priced exactly at a level that moves reverts with
   * ImmediateOrCancelNoFill.
   */
  private send(
    market: PerpMarket,
    side: Side,
    quantity: bigint,
    touch: bigint,
    label: string,
    source: string,
  ): Promise<OrderOutcome> {
    return this.writes.run(async () => {
      const slip = BigInt(Math.max(0, Math.round(Number(process.env.SLIPPAGE_BPS ?? 30))));
      const raw = side === "long" ? (touch * (10_000n + slip)) / 10_000n : (touch * (10_000n - slip)) / 10_000n;
      const price = alignPrice(raw, market.info);
      const size = Number(formatUnits(quantity, market.info.baseDecimals));
      const px = Number(formatUnits(price, 18));
      const what = `${label} ${side === "long" ? "buy" : "sell"} ${trimNum(size)} ${market.info.baseSymbol} (limit ${fmtPrice(px)})`;

      if (this.dryRun) {
        journal({ source, market: market.display, action: label, side, size, price: px, dryRun: true });
        return { ok: true, message: `[dry run] would ${what}` };
      }

      const order = { pool: market.info.poolAddress, isBid: side === "long", price, quantity, orderType: ORDER_TYPE.MARKET };
      try {
        const res = this.ctx.tradingKey
          ? await placeFor(this.ctx.tradingKey, order)
          : await this.ctx.exchange.trader.placePerpOrder(order);
        const filledRaw = (res.fills ?? []).reduce((sum, fill) => sum + fill.quantityFilled, 0n);
        const filled = Number(formatUnits(filledRaw, market.info.baseDecimals));
        journal({ source, market: market.display, action: label, side, size, price: px, filled, hash: res.hash });
        if (filledRaw === 0n) return { ok: false, hash: res.hash, filled, message: `${what}: nothing filled, the book moved` };
        return { ok: true, hash: res.hash, filled, price: px, message: `${what}: filled ${trimNum(filled)}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        journal({ source, market: market.display, action: label, side, size, price: px, error: msg.slice(0, 300) });
        return { ok: false, message: `${what} failed: ${explain(msg)}` };
      }
    });
  }
}

/** Turn the revert names traders hit most often into something they can act on. */
export function explain(message: string): string {
  const known: [string, string][] = [
    ["ImmediateOrCancelNoFill", "nothing crossed, the price moved. Try again"],
    ["InsufficientCollateral", "not enough free margin in the Perps account"],
    ["MaxPositionSizeExceeded", "that would exceed the per-account position cap on this market"],
    ["MaxOpenInterestExceeded", "the market's open-interest cap is full"],
    ["IsolatedMarketBlocked", "this account is isolated to another market"],
    ["OnlyApprovedContracts", "the bot key is not linked for this market (Link a bot in the app)"],
    ["StaleOraclePrice", "the price feed is stale right now, try again in a moment"],
  ];
  for (const [needle, text] of known) if (message.includes(needle)) return text;
  return message.split("\n")[0]?.slice(0, 200) ?? message;
}

export function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function fmtPrice(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "?";
  return Math.abs(v) >= 1 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v.toPrecision(4);
}

export function fmtHealth(h: number): string {
  return Number.isFinite(h) ? `${h.toFixed(2)}x` : "∞ (no position)";
}

export function trimNum(v: number): string {
  return Number(v.toPrecision(6)).toString();
}

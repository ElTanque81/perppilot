// The margin guard and price alerts: a loop that runs beside the chat.
//
// Health is equity over the maintenance requirement (1.0 = liquidation line).
// Liquidation on dreamDEX closes on the book and then charges a fee, so trimming
// early, voluntarily, is cheaper than being closed at the line. The guard works
// in bands and only speaks when the account moves into a worse band, so a
// position sitting at 1.8x does not send a message every 30 seconds.

import { fmtHealth, fmtPrice, type Pilot } from "./pilot.js";

export type GuardMode = "off" | "alert" | "auto";

export interface GuardSettings {
  mode: GuardMode;
  warnBelow: number;
  reduceBelow: number;
  flattenBelow: number;
  reducePct: number;
  pollMs: number;
}

export interface PriceAlert {
  id: number;
  symbol: string;
  above: boolean;
  price: number;
}

type Band = "ok" | "warn" | "reduce" | "flatten";

export class Guard {
  private band: Band = "ok";
  private alerts: PriceAlert[] = [];
  private nextId = 1;
  private timer?: NodeJS.Timeout;
  private running = false;
  lastHealth = Number.POSITIVE_INFINITY;
  lastCheck?: Date;

  constructor(
    private readonly pilot: Pilot,
    readonly settings: GuardSettings,
    private readonly notify: (html: string) => Promise<void>,
  ) {
    if (settings.flattenBelow > settings.reduceBelow || settings.reduceBelow > settings.warnBelow) {
      throw new Error("Guard thresholds must satisfy FLATTEN_BELOW < REDUCE_BELOW < WARN_BELOW.");
    }
  }

  start(): void {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.check();
      } catch (err) {
        console.error(`guard tick failed: ${(err as Error).message}`);
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(tick, this.settings.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  addAlert(symbol: string, above: boolean, price: number): PriceAlert {
    const alert = { id: this.nextId++, symbol: symbol.toUpperCase(), above, price };
    this.alerts.push(alert);
    return alert;
  }

  removeAlert(id: number): boolean {
    const before = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.id !== id);
    return this.alerts.length < before;
  }

  listAlerts(): PriceAlert[] {
    return [...this.alerts];
  }

  private classify(h: number): Band {
    const s = this.settings;
    if (h < s.flattenBelow) return "flatten";
    if (h < s.reduceBelow) return "reduce";
    if (h < s.warnBelow) return "warn";
    return "ok";
  }

  async check(): Promise<void> {
    this.lastCheck = new Date();
    await this.checkAlerts();
    if (this.settings.mode === "off" || !this.pilot.account) return;

    const view = await this.pilot.accountView();
    this.lastHealth = view.health;
    const band = this.classify(view.health);
    const order: Band[] = ["ok", "warn", "reduce", "flatten"];
    const worse = order.indexOf(band) > order.indexOf(this.band);
    const previous = this.band;
    this.band = band;

    if (band === "ok") {
      if (previous !== "ok") await this.notify(`✅ Margin health back to <b>${fmtHealth(view.health)}</b>. Guard stands down.`);
      return;
    }

    const lines = view.positions.map(
      (p) =>
        `• ${p.market.display} ${p.side} ${p.size} · mark ${fmtPrice(p.mark)} · liq ${fmtPrice(p.liq)}` +
        (p.liqDistancePct !== undefined ? ` (${p.liqDistancePct.toFixed(2)}% away)` : ""),
    );
    const head = `Margin health <b>${fmtHealth(view.health)}</b> (1.00x = liquidation)`;

    // Acting is re-evaluated every tick while in a reduce/flatten band, so a
    // position that keeps sliding keeps being trimmed; messages only on entry.
    if (band === "warn") {
      if (worse) await this.notify(`⚠️ ${head}\n${lines.join("\n")}\nReply /pos for details or /close to cut risk.`);
      return;
    }

    if (this.settings.mode !== "auto") {
      if (worse) {
        await this.notify(
          `🚨 ${head}\n${lines.join("\n")}\nGuard is in alert-only mode. ` +
            (band === "flatten" ? "Close now: /close ALL" : `Consider /close SYMBOL ${this.settings.reducePct}`),
        );
      }
      return;
    }

    const fraction = band === "flatten" ? 1 : this.settings.reducePct / 100;
    const results: string[] = [];
    for (const p of view.positions) {
      const out = await this.pilot.close(p.market.display, fraction, "guard");
      results.push(`${out.ok ? "•" : "✗"} ${out.message}${out.hash ? `\n  tx <code>${out.hash}</code>` : ""}`);
    }
    await this.notify(
      `🛡️ ${head}\nGuard ${band === "flatten" ? "flattened everything" : `trimmed ${this.settings.reducePct}% of each position`}:\n` +
        results.join("\n"),
    );
  }

  private async checkAlerts(): Promise<void> {
    if (this.alerts.length === 0) return;
    const fired: PriceAlert[] = [];
    for (const alert of this.alerts) {
      try {
        const market = await this.pilot.market(alert.symbol);
        const mark = await this.pilot.mark(market);
        if (mark === undefined) continue;
        if ((alert.above && mark >= alert.price) || (!alert.above && mark <= alert.price)) {
          fired.push(alert);
          await this.notify(
            `🔔 <b>${market.display}</b> is ${alert.above ? "above" : "below"} ${fmtPrice(alert.price)}: mark ${fmtPrice(mark)}\n` +
              `Trade it: /long ${alert.symbol} 25 · /short ${alert.symbol} 25`,
          );
        }
      } catch (err) {
        console.error(`alert ${alert.id} check failed: ${(err as Error).message}`);
      }
    }
    this.alerts = this.alerts.filter((a) => !fired.includes(a));
  }
}

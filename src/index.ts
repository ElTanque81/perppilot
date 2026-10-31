// PerpPilot: a Telegram co-pilot for dreamDEX perps on Somnia Tokyo testnet.
//
//   npm start
//
// Only the chat in TELEGRAM_CHAT_ID can use it. Every order asks for a tap on
// "Confirm" first, and every sent order is answered with its transaction hash.

import { Bot, InlineKeyboard, type Context } from "grammy";
import { envNum, loadEnv, type Side } from "./perp-core/index.js";
import { Guard, type GuardMode } from "./guard.js";
import { recent } from "./journal.js";
import { Pilot, explain, fmtHealth, fmtPrice, trimNum, type OrderOutcome } from "./pilot.js";

loadEnv();

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
const MAX_NOTIONAL = envNum("MAX_NOTIONAL_USDSO", 200);
const CONFIRM_TTL_MS = 60_000;

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is missing. Create a bot with @BotFather and put its token in .env.");
  process.exit(1);
}

const pilot = new Pilot();
const bot = new Bot(TOKEN);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const send = async (html: string) => {
  if (CHAT_ID) await bot.api.sendMessage(CHAT_ID, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
};

const guard = new Guard(
  pilot,
  {
    mode: parseMode(process.env.GUARD_MODE) ?? "alert",
    warnBelow: envNum("GUARD_WARN_BELOW", 2),
    reduceBelow: envNum("GUARD_REDUCE_BELOW", 1.5),
    flattenBelow: envNum("GUARD_FLATTEN_BELOW", 1.15),
    reducePct: envNum("GUARD_REDUCE_PCT", 25),
    pollMs: envNum("GUARD_POLL_MS", 30_000),
  },
  send,
);

function parseMode(v: string | undefined): GuardMode | undefined {
  const m = (v ?? "").trim().toLowerCase();
  return m === "off" || m === "alert" || m === "auto" ? m : undefined;
}

// ---------------------------------------------------------------- access ----

bot.use(async (ctx, next) => {
  const id = String(ctx.chat?.id ?? "");
  if (!CHAT_ID) {
    await ctx.reply(`Your chat id is ${id}. Put TELEGRAM_CHAT_ID=${id} in .env and restart PerpPilot.`);
    return;
  }
  if (id !== CHAT_ID) {
    // Ignored, but say so in the terminal: a wrong TELEGRAM_CHAT_ID otherwise
    // looks exactly like a bot that is not running.
    console.log(`ignored a message from chat ${id} (TELEGRAM_CHAT_ID is ${CHAT_ID}). If that is you, set TELEGRAM_CHAT_ID=${id}`);
    return;
  }
  await next();
});

const args = (ctx: Context) => (ctx.match ? String(ctx.match).trim().split(/\s+/).filter(Boolean) : []);
const reply = (ctx: Context, html: string, keyboard?: InlineKeyboard) =>
  ctx.reply(html, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } });

/** Run a handler and turn any error into a readable chat line. */
const safe =
  (fn: (ctx: Context) => Promise<unknown>) =>
  async (ctx: Context): Promise<void> => {
    try {
      await fn(ctx);
    } catch (err) {
      await reply(ctx, `✗ ${esc(explain(err instanceof Error ? err.message : String(err)))}`);
    }
  };

// ------------------------------------------------------- confirmations ------

interface Pending {
  run: () => Promise<OrderOutcome[]>;
  summary: string;
  expires: number;
}
const pending = new Map<string, Pending>();
let seq = 0;

async function askConfirm(ctx: Context, summary: string, run: Pending["run"]): Promise<void> {
  const id = String(++seq);
  pending.set(id, { run, summary, expires: Date.now() + CONFIRM_TTL_MS });
  const kb = new InlineKeyboard().text("✅ Confirm", `ok:${id}`).text("✖ Cancel", `no:${id}`);
  const mode = pilot.dryRun ? "\n<i>Dry run: nothing will be sent.</i>" : "";
  await reply(ctx, `${summary}${mode}`, kb);
}

bot.callbackQuery(/^(ok|no):(\d+)$/, async (ctx) => {
  const [, verb, id] = ctx.match as RegExpMatchArray;
  const p = pending.get(id!);
  pending.delete(id!);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  if (!p) return reply(ctx, "That request is gone. Send the command again.");
  if (verb === "no") return reply(ctx, "Cancelled.");
  if (Date.now() > p.expires) return reply(ctx, "Expired (prices move). Send the command again.");
  await reply(ctx, "⏳ Sending…");
  try {
    const outcomes = await p.run();
    for (const o of outcomes) await reply(ctx, outcomeHtml(o));
  } catch (err) {
    await reply(ctx, `✗ ${esc(explain(err instanceof Error ? err.message : String(err)))}`);
  }
});

function outcomeHtml(o: OrderOutcome): string {
  const icon = o.ok ? "✅" : "✗";
  return `${icon} ${esc(o.message)}${o.hash ? `\ntx <code>${o.hash}</code>` : ""}`;
}

// ------------------------------------------------------------ commands ------

const HELP = [
  "<b>PerpPilot</b> · dreamDEX perps from Telegram (Somnia Tokyo testnet)",
  "",
  "<b>Trade</b> (every order asks you to confirm)",
  "/long BTC 50 · open or add a long worth 50 USDso",
  "/short ETH 25 · open or add a short worth 25 USDso",
  "/close BTC · close the BTC position · /close BTC 50 · close half",
  "/close ALL · flatten everything",
  "",
  "<b>Look</b>",
  "/pos · positions, PnL, liquidation price, margin health",
  "/price BTC · live mark, index and funding",
  "/markets · all perp markets",
  "/trades · last orders with tx hashes",
  "",
  "<b>Protect</b>",
  "/guard · guard status · /guard off|alert|auto",
  "/alert BTC &gt; 90000 · ping me when BTC crosses a price",
  "/alerts · list · /unalert 3 · remove",
  "/status · connection, link and margin check",
].join("\n");

bot.command(["start", "help"], (ctx) => reply(ctx, HELP));

bot.command(
  "status",
  safe(async (ctx) => {
    const lines = await pilot.selfCheck();
    lines.push(`guard: ${guard.settings.mode} · warn &lt; ${guard.settings.warnBelow}x · reduce &lt; ${guard.settings.reduceBelow}x · flatten &lt; ${guard.settings.flattenBelow}x`);
    await reply(ctx, lines.map((l) => (l.includes("&lt;") ? l : esc(l))).join("\n"));
  }),
);

bot.command(
  "markets",
  safe(async (ctx) => {
    const markets = await pilot.markets();
    const rows = await Promise.all(
      markets.map(async (m) => {
        const [mark, f] = await Promise.all([pilot.mark(m), pilot.funding(m)]);
        const lev = Math.round(10_000 / Math.max(1, Number(m.info.initialMarginBps)));
        return `${m.display.padEnd(14)} ${fmtPrice(mark).padStart(10)}  ${lev}x  ${(f.apr * 100).toFixed(1)}% APR`;
      }),
    );
    await reply(ctx, `<b>Perp markets</b> (mark · max lev · funding APR)\n<pre>${esc(rows.join("\n"))}</pre>`);
  }),
);

bot.command(
  "price",
  safe(async (ctx) => {
    const [sym] = args(ctx);
    if (!sym) return reply(ctx, "Usage: /price BTC");
    const m = await pilot.market(sym);
    const [mark, f, state] = await Promise.all([
      pilot.mark(m),
      pilot.funding(m),
      // Read the index from the chain: the indexer row lags by tens of minutes.
      pilot.ctx.exchange.client.getPerpState(m.info.poolAddress).catch(() => undefined),
    ]);
    const index = Number(state?.indexPrice ?? BigInt(m.info.indexPrice ?? "0")) / 1e18;
    const who = f.positive ? "longs pay shorts" : "shorts pay longs";
    await reply(
      ctx,
      `<b>${m.display}</b>\nmark ${fmtPrice(mark)} · index ${fmtPrice(index)}\n` +
        `funding ${(f.apr * 100).toFixed(2)}% APR (${who}, every ${Math.round(f.intervalSec / 60)} min)`,
    );
  }),
);

bot.command(
  "pos",
  safe(async (ctx) => {
    const v = await pilot.accountView();
    const head = `<b>Account</b> ${esc(pilot.mode)}\nequity ${v.equity.toFixed(2)} USDso · free ${v.free.toFixed(2)} · health <b>${fmtHealth(v.health)}</b>`;
    if (v.positions.length === 0) return reply(ctx, `${head}\nNo open positions.`);
    const body = v.positions.map((p) => {
      const pnl = p.uPnl === undefined ? "?" : `${p.uPnl >= 0 ? "+" : ""}${p.uPnl.toFixed(2)}`;
      return (
        `<b>${p.market.display}</b> ${p.side === "long" ? "🟢 long" : "🔴 short"} ${trimNum(p.size)} ` +
        `(${p.notional.toFixed(2)} USDso)\n` +
        `entry ${fmtPrice(p.entry)} · mark ${fmtPrice(p.mark)} · uPnL ${pnl}\n` +
        `liq ${fmtPrice(p.liq)}${p.liqDistancePct !== undefined ? ` · ${p.liqDistancePct.toFixed(2)}% away` : ""}`
      );
    });
    await reply(ctx, `${head}\n\n${body.join("\n\n")}`);
  }),
);

function openCommand(side: Side) {
  return safe(async (ctx) => {
    const [sym, amount] = args(ctx);
    const notional = Number(amount);
    if (!sym || !(notional > 0)) return reply(ctx, `Usage: /${side} BTC 50  (size in USDso notional)`);
    if (notional > MAX_NOTIONAL) {
      return reply(ctx, `That is above MAX_NOTIONAL_USDSO (${MAX_NOTIONAL}). Raise it in .env if you mean it.`);
    }
    const m = await pilot.market(sym);
    const mark = await pilot.mark(m);
    const size = mark ? notional / mark : undefined;
    await askConfirm(
      ctx,
      `${side === "long" ? "🟢 Long" : "🔴 Short"} <b>${m.display}</b> for ${notional} USDso` +
        (size ? ` (≈${trimNum(size)} ${esc(m.info.baseSymbol)} at ${fmtPrice(mark)})` : "") +
        `\nMarket order (IOC), up to ${Number(process.env.SLIPPAGE_BPS ?? 30) / 100}% slippage.`,
      async () => [await pilot.open(m.display, side, notional)],
    );
  });
}
bot.command("long", openCommand("long"));
bot.command("short", openCommand("short"));

bot.command(
  "close",
  safe(async (ctx) => {
    const [sym, pctArg] = args(ctx);
    if (!sym) return reply(ctx, "Usage: /close BTC [percent] · /close ALL");
    const pct = pctArg ? Number(pctArg) : 100;
    if (!(pct > 0 && pct <= 100)) return reply(ctx, "Percent must be between 1 and 100.");
    if (sym.toUpperCase() === "ALL") {
      const v = await pilot.accountView();
      if (v.positions.length === 0) return reply(ctx, "No open positions.");
      const names = v.positions.map((p) => p.market.display);
      return askConfirm(ctx, `Close <b>${pct}%</b> of: ${names.join(", ")}`, async () => {
        const out: OrderOutcome[] = [];
        for (const n of names) out.push(await pilot.close(n, pct / 100));
        return out;
      });
    }
    const m = await pilot.market(sym);
    await askConfirm(ctx, `Close <b>${pct}%</b> of the ${m.display} position at market`, async () => [
      await pilot.close(m.display, pct / 100),
    ]);
  }),
);

bot.command(
  "guard",
  safe(async (ctx) => {
    const [m] = args(ctx);
    const mode = parseMode(m);
    if (m && !mode) return reply(ctx, "Usage: /guard off | alert | auto");
    if (mode) guard.settings.mode = mode;
    const s = guard.settings;
    const what: Record<GuardMode, string> = {
      off: "not watching margin",
      alert: "messages you when health drops into a worse band",
      auto: `messages you, trims ${s.reducePct}% below ${s.reduceBelow}x and closes everything below ${s.flattenBelow}x`,
    };
    await reply(
      ctx,
      `🛡️ Guard <b>${s.mode}</b>: ${what[s.mode]}\nbands: warn &lt; ${s.warnBelow}x · reduce &lt; ${s.reduceBelow}x · flatten &lt; ${s.flattenBelow}x\n` +
        `last health ${fmtHealth(guard.lastHealth)}${guard.lastCheck ? ` at ${guard.lastCheck.toISOString().slice(11, 19)} UTC` : ""}`,
    );
  }),
);

bot.command(
  "alert",
  safe(async (ctx) => {
    const text = String(ctx.match ?? "").trim();
    const hit = text.match(/^([A-Za-z0-9-]+)\s*([<>])\s*([\d.]+)$/);
    if (!hit) return reply(ctx, "Usage: /alert BTC &gt; 90000 · /alert ETH &lt; 2200");
    const m = await pilot.market(hit[1]!);
    const a = guard.addAlert(m.info.baseSymbol, hit[2] === ">", Number(hit[3]));
    await reply(ctx, `🔔 Alert #${a.id}: ${m.display} ${a.above ? "&gt;" : "&lt;"} ${fmtPrice(a.price)} (checked every ${guard.settings.pollMs / 1000}s)`);
  }),
);

bot.command("alerts", (ctx) => {
  const list = guard.listAlerts();
  return reply(
    ctx,
    list.length === 0
      ? "No price alerts. Add one: /alert BTC &gt; 90000"
      : list.map((a) => `#${a.id} ${a.symbol}-PERP ${a.above ? "&gt;" : "&lt;"} ${fmtPrice(a.price)}`).join("\n"),
  );
});

bot.command("unalert", (ctx) => {
  const id = Number(args(ctx)[0]);
  return reply(ctx, guard.removeAlert(id) ? `Removed alert #${id}.` : "No alert with that number. /alerts lists them.");
});

bot.command("trades", (ctx) => {
  const rows = recent(8);
  if (rows.length === 0) return reply(ctx, "No orders yet.");
  const body = rows.map((r) => {
    const status = r.dryRun ? "dry run" : r.error ? `failed: ${esc(explain(r.error))}` : `filled ${r.filled ?? 0}`;
    return `${r.at.slice(5, 16).replace("T", " ")} ${esc(r.market)} ${esc(r.action)} ${r.size} · ${status}` +
      (r.hash ? `\n<code>${r.hash}</code>` : "");
  });
  return reply(ctx, body.join("\n\n"));
});

// ------------------------------------------------------------ startup -------

bot.catch((err) => console.error(`telegram handler error: ${err.message}`));

async function main(): Promise<void> {
  // Telegram first: a slow or failing chain check must not keep the bot deaf.
  const me = await bot.api.getMe().catch((err: Error) => {
    throw new Error(`Telegram rejected TELEGRAM_BOT_TOKEN (${err.message}). Copy the token from @BotFather again.`);
  });
  console.log(`Telegram: connected as @${me.username}${CHAT_ID ? ` · answering chat ${CHAT_ID}` : " · TELEGRAM_CHAT_ID not set yet: send /start to the bot"}`);

  let lines: string[];
  try {
    lines = await Promise.race([
      pilot.selfCheck(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out after 30 s")), 30_000)),
    ]);
  } catch (err) {
    lines = [`chain check failed: ${explain((err as Error).message)} (the bot still runs; try /status)`];
  }
  for (const l of lines) console.log(l);
  await bot.api.setMyCommands([
    { command: "pos", description: "Positions, PnL, liquidation price, health" },
    { command: "long", description: "Open a long: /long BTC 50" },
    { command: "short", description: "Open a short: /short ETH 25" },
    { command: "close", description: "Close: /close BTC [percent] or /close ALL" },
    { command: "price", description: "Mark, index, funding: /price BTC" },
    { command: "markets", description: "All perp markets" },
    { command: "guard", description: "Margin guard: off | alert | auto" },
    { command: "alert", description: "Price alert: /alert BTC > 90000" },
    { command: "trades", description: "Recent orders with tx hashes" },
    { command: "status", description: "Connection and account check" },
    { command: "help", description: "All commands" },
  ]);
  guard.start();
  if (CHAT_ID) await send(`🚀 PerpPilot is up\n${esc(lines.join("\n"))}\n\n/help for commands`).catch(() => undefined);
  console.log(`PerpPilot running. Open https://t.me/${me.username} and send /start. Ctrl+C to stop.`);
  const stop = () => {
    guard.stop();
    void bot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await bot.start();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

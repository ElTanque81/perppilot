// Read-only preflight without Telegram: network, link, margin, positions, and
// one market's live price. Sends nothing.
//
//   npm run doctor            (or: npm run doctor -- ETH)

import { loadEnv } from "./perp-core/index.js";
import { Pilot, fmtHealth, fmtPrice } from "./pilot.js";

loadEnv();

async function main(): Promise<void> {
  const pilot = new Pilot();
  for (const line of await pilot.selfCheck()) console.log(line);

  const sym = process.argv[2] ?? "BTC";
  const m = await pilot.market(sym);
  const [mark, f] = await Promise.all([pilot.mark(m), pilot.funding(m)]);
  console.log(`${m.display}: mark ${fmtPrice(mark)} · funding ${(f.apr * 100).toFixed(2)}% APR`);

  if (pilot.account) {
    const v = await pilot.accountView();
    console.log(`health ${fmtHealth(v.health)} · ${v.positions.length} open position(s)`);
    for (const p of v.positions) {
      console.log(`  ${p.market.display} ${p.side} ${p.size} · entry ${fmtPrice(p.entry)} · liq ${fmtPrice(p.liq)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

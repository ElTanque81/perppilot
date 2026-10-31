// Append-only trade journal (trades.jsonl). Every order the bot sends, including
// dry runs and failures, lands here with its transaction hash: the evidence a
// reviewer can check on Somnia Tokyo testnet.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(process.env.JOURNAL_FILE ?? "trades.jsonl");

export interface JournalEntry {
  source: string;
  market: string;
  action: string;
  side: string;
  size: number;
  price: number;
  filled?: number;
  hash?: string;
  error?: string;
  dryRun?: boolean;
}

export function journal(entry: JournalEntry): void {
  try {
    appendFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error(`journal write failed: ${(err as Error).message}`);
  }
}

export function recent(n = 10): (JournalEntry & { at: string })[] {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-n)
    .map((line) => JSON.parse(line));
}

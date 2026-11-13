/**
 * plan_upgrades: "what cheap items improve my build?"
 *
 * For each gear slot: PoB builds its own weighted best-upgrade trade query
 * (TradeQueryGenerator), we add the budget and search instant-buyout listings,
 * fetch the top few, convert them to PoB items and simulate each one in the
 * build. Results are ranked by improvement per chaos. Trade traffic stays
 * inside the per-question request budget enforced by the trade client.
 */
import { wrapHandler } from "../utils/errorHandling.js";
import type { PoBLuaApiClient, ItemTestStats } from "../pobLuaBridge.js";
import type { TradeApiClient } from "../services/tradeClient.js";
import type { PoeNinjaClient } from "../services/poeNinjaClient.js";
import type { TradeQuery } from "../types/tradeTypes.js";
import { defaultOnlineStatus } from "../services/tradeQueryBuilder.js";
import { tradeItemToPoBText, priceInChaos } from "../services/tradeItemText.js";

interface UpgradeContext {
  tradeClient: TradeApiClient;
  ninjaClient?: PoeNinjaClient;
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

export interface UpgradeArgs {
  league: string;
  budget_chaos?: number;
  focus?: "balanced" | "dps" | "defence";
  slots?: string[];
  per_slot?: number;
  max_results?: number;
}

export interface UpgradeCandidate {
  slot: string;
  name: string;
  rarity?: string;
  priceChaos: number;
  priceText: string;
  dpsPct: number;
  ehpPct: number;
  lifeDelta: number;
  resNotes: string[];
  warnings: string[];
  score: number;
  value: number;
  url: string;
  itemText: string;
  seller?: string;
}

const DEFAULT_SLOTS = ["Helmet", "Body Armour", "Gloves", "Boots", "Belt", "Amulet", "Ring 1"];
const RES = [["FireResist", "Fire"], ["ColdResist", "Cold"], ["LightningResist", "Lightning"]] as const;

function weightsFor(focus: string) {
  if (focus === "dps") return [{ label: "Full DPS", stat: "FullDPS", weightMult: 1.0 }];
  if (focus === "defence") return [{ label: "Effective Hit Pool", stat: "TotalEHP", weightMult: 1.0 }];
  return [{ label: "Full DPS", stat: "FullDPS", weightMult: 1.0 }, { label: "Effective Hit Pool", stat: "TotalEHP", weightMult: 0.5 }];
}

function dps(s: ItemTestStats) {
  return (s.FullDPS && s.FullDPS > 0) ? s.FullDPS : (s.CombinedDPS ?? s.TotalDPS ?? 0);
}

function pct(a: number, b: number) {
  return b > 0 ? (a - b) / b * 100 : 0;
}

export function evaluateCandidate(base: ItemTestStats, test: ItemTestStats, focus: string) {
  const dpsPct = pct(dps(test), dps(base));
  const ehpPct = pct(test.TotalEHP ?? 0, base.TotalEHP ?? 0);
  const lifeDelta = (test.Life ?? 0) - (base.Life ?? 0);
  const resNotes: string[] = [];
  const warnings: string[] = [];
  let resPenalty = 0;
  for (const [key, label] of RES) {
    const b = base[key] ?? 0, t = test[key] ?? 0;
    if (t < 75 && t < b) { warnings.push(`${label} res drops to ${Math.round(t)}%`); resPenalty += (75 - t); }
    else if (b < 75 && t > b) resNotes.push(`${label} res ${Math.round(b)}% -> ${Math.round(t)}%`);
  }
  const cb = base.ChaosResist ?? 0, ct = test.ChaosResist ?? 0;
  if (Math.abs(ct - cb) >= 5) resNotes.push(`Chaos res ${Math.round(cb)}% -> ${Math.round(ct)}%`);
  for (const [attr, req] of [["Str", "ReqStr"], ["Dex", "ReqDex"], ["Int", "ReqInt"]]) {
    if ((test[req] ?? 0) > (test[attr] ?? 0)) warnings.push(`${attr} requirement not met (${Math.round(test[attr] ?? 0)}/${Math.round(test[req] ?? 0)})`);
  }
  if ((test.ManaUnreserved ?? 0) < 0 && (base.ManaUnreserved ?? 0) >= 0) warnings.push("mana becomes over-reserved");
  const w = focus === "dps" ? [1, 0.15] : focus === "defence" ? [0.15, 1] : [1, 0.6];
  let score = dpsPct * w[0] + ehpPct * w[1] + resNotes.length * 2 - resPenalty * 0.5 - (warnings.length > 0 ? 10 : 0);
  if (!Number.isFinite(score)) score = 0;
  return { dpsPct, ehpPct, lifeDelta, resNotes, warnings, score };
}

function tradeUrl(league: string, searchId: string, itemId?: string) {
  return `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}/${searchId}${itemId ? `#${itemId}` : ""}`;
}

export async function planUpgrades(context: UpgradeContext, args: UpgradeArgs): Promise<{ candidates: UpgradeCandidate[]; notes: string[]; base?: ItemTestStats }> {
  const budget = Math.max(1, args.budget_chaos ?? 50);
  const focus = args.focus ?? "balanced";
  const slots = (args.slots && args.slots.length ? args.slots : DEFAULT_SLOTS).slice(0, 8);
  const perSlot = Math.min(Math.max(args.per_slot ?? 4, 1), 8);
  const notes: string[] = [];

  await context.ensureLuaClient();
  const lua = context.getLuaClient();
  if (!lua) throw new Error("PoB is not available; load a build first (lua_load_build) or open PoB Agent Edition.");

  let rates = new Map<string, number>([["Chaos Orb", 1]]);
  try {
    if (context.ninjaClient) rates = await context.ninjaClient.getCurrencyExchangeMap(args.league);
  } catch {
    notes.push("Could not load currency rates from poe.ninja; only chaos-priced listings are compared.");
  }

  const candidates: UpgradeCandidate[] = [];
  let base: ItemTestStats | undefined;
  for (const slot of slots) {
    let searchId: string;
    let listings;
    try {
      const { query } = await lua.generateWeightedTradeQuery(slot, { statWeights: weightsFor(focus) });
      const q = query as TradeQuery & { query: { filters?: Record<string, unknown> } };
      if (!q?.query) { notes.push(`${slot}: PoB produced no query`); continue; }
      q.query.status = { option: defaultOnlineStatus() };
      const filters = (q.query.filters ??= {}) as Record<string, { filters?: Record<string, unknown> }>;
      filters.trade_filters = { filters: { ...(filters.trade_filters?.filters ?? {}), price: { max: budget } } };
      const search = await context.tradeClient.searchItems(args.league, q as TradeQuery);
      searchId = search.id;
      if (!search.result?.length) { notes.push(`${slot}: nothing under ${budget}c`); continue; }
      listings = await context.tradeClient.fetchItems(search.result.slice(0, perSlot), search.id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      notes.push(`${slot}: ${msg}`);
      // Budget or rate-limit stops end the whole plan; other errors skip the slot.
      if (/Stopped after|asks for a pause|slow down/i.test(msg)) break;
      continue;
    }

    const usable = listings
      .map((l) => ({ l, chaos: priceInChaos(l.listing.price, rates) }))
      .filter((x) => x.chaos !== undefined && x.chaos <= budget * 1.001);
    if (!usable.length) { notes.push(`${slot}: no listings with a known price under ${budget}c`); continue; }
    const texts = usable.map((x) => tradeItemToPoBText(x.l.item));
    let report;
    try {
      report = await lua.testItems(slot, texts);
    } catch (error) {
      notes.push(`${slot}: PoB could not test items (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    base = report.base;
    report.results.forEach((r, i) => {
      if (!r.ok || !r.stats) return;
      const { l, chaos } = usable[i];
      const ev = evaluateCandidate(report.base, r.stats, focus);
      // Not an upgrade: overall score too low, or a big loss on the focused stat.
      if (ev.score <= 0.5) return;
      if (focus !== "defence" && ev.dpsPct < -5) return;
      if (focus !== "dps" && ev.ehpPct < -5) return;
      const price = l.listing.price!;
      candidates.push({
        slot,
        name: [l.item.name, l.item.typeLine].filter(Boolean).join(", "),
        rarity: r.rarity,
        priceChaos: chaos!,
        priceText: `${price.amount} ${price.currency}`,
        ...ev,
        value: ev.score / Math.max(chaos!, 1),
        url: tradeUrl(args.league, searchId, l.id),
        itemText: texts[i],
        seller: l.listing.account?.name,
      });
    });
  }

  candidates.sort((a, b) => b.value - a.value || b.score - a.score);
  return { candidates: candidates.slice(0, Math.max(1, args.max_results ?? 8)), notes, base };
}

export function formatPlan(league: string, budget: number, result: { candidates: UpgradeCandidate[]; notes: string[] }): string {
  const lines = [`=== Upgrade plan (${league}, up to ${budget}c per item, instant buyout) ===`, ""];
  if (!result.candidates.length) lines.push("No upgrades found within the budget for the searched slots.");
  result.candidates.forEach((c, i) => {
    const parts = [`DPS ${c.dpsPct >= 0 ? "+" : ""}${c.dpsPct.toFixed(1)}%`, `EHP ${c.ehpPct >= 0 ? "+" : ""}${c.ehpPct.toFixed(1)}%`];
    if (Math.abs(c.lifeDelta) >= 1) parts.push(`Life ${c.lifeDelta > 0 ? "+" : ""}${Math.round(c.lifeDelta)}`);
    lines.push(`${i + 1}. [${c.slot}] ${c.name} - ${c.priceText} (~${Math.round(c.priceChaos)}c)`);
    lines.push(`   ${parts.join(" | ")}${c.resNotes.length ? " | " + c.resNotes.join(", ") : ""}`);
    if (c.warnings.length) lines.push(`   Warning: ${c.warnings.join("; ")}`);
    lines.push(`   ${c.url}`);
  });
  if (result.notes.length) { lines.push("", "Notes:"); for (const n of result.notes) lines.push(`- ${n}`); }
  lines.push("", "Numbers are PoB simulations of swapping each item into your current build (config as set in PoB). Open a link and use the instant buyout to buy.");
  return lines.join("\n");
}

export async function handlePlanUpgrades(context: UpgradeContext, args: UpgradeArgs) {
  return wrapHandler("plan upgrades", async () => {
    const budget = Math.max(1, args.budget_chaos ?? 50);
    const result = await planUpgrades(context, args);
    const lua = context.getLuaClient();
    let shown = "";
    if (lua?.isLive()) {
      try {
        await lua.liveAction("set_advisor", {
          league: args.league, budget, focus: args.focus ?? "balanced", time: Date.now(),
          items: result.candidates.map((c) => ({
            slot: c.slot, name: c.name, rarity: c.rarity, priceText: c.priceText, priceChaos: c.priceChaos,
            dpsPct: c.dpsPct, ehpPct: c.ehpPct, lifeDelta: c.lifeDelta, resNotes: c.resNotes, warnings: c.warnings,
            url: c.url, itemText: c.itemText, seller: c.seller,
          })),
          notes: result.notes,
        });
        shown = "\n\nShown in PoB Agent Edition > Overview > Advisor (hover to compare, click to open the listing).";
      } catch { /* window may be closed; text result is still complete */ }
    }
    return { content: [{ type: "text" as const, text: formatPlan(args.league, budget, result) + shown }] };
  });
}

/**
 * Turns a trade API listing into Path of Building's item text format, so PoB
 * can parse it and simulate it in the build. Mirrors PoB's own conversion in
 * Classes/TradeQueryRequests.lua.
 */
import type { TradeItem } from "../types/tradeTypes.js";

const FRAME_RARITY: Record<number, string> = { 0: "NORMAL", 1: "MAGIC", 2: "RARE", 3: "UNIQUE", 9: "RELIC" };

/** Strip GGG markup such as "[Lightning|Lightning]" -> "Lightning". */
function clean(s: unknown): string {
  // Mods are usually plain strings; some endpoints return { description } objects.
  const text = typeof s === "string" ? s
    : (s && typeof s === "object" && typeof (s as { description?: unknown }).description === "string") ? (s as { description: string }).description
    : String(s ?? "");
  return text.replace(/\[([^\]|]+)\|([^\]]+)\]/g, "$2").replace(/\[([^\]]+)\]/g, "$1");
}

type LooseItem = TradeItem & {
  corrupted?: boolean;
  duplicated?: boolean;
  scourgeMods?: string[];
  fracturedMods?: string[];
  craftedMods?: string[];
  enchantMods?: string[];
};

export function tradeItemToPoBText(item: TradeItem): string {
  const it = item as LooseItem;
  const lines: string[] = [];
  const rarity = it.rarity?.toUpperCase() || FRAME_RARITY[it.frameType] || "RARE";
  lines.push(`Rarity: ${rarity}`);
  if (it.name) lines.push(clean(it.name));
  lines.push(clean(it.typeLine));

  const quality = it.properties?.find((p) => p.name === "Quality");
  const qVal = quality && Array.isArray(quality.values) && quality.values[0] ? String(quality.values[0][0]) : undefined;
  if (qVal) lines.push(`Quality: ${qVal}`);
  if (it.ilvl) lines.push(`Item Level: ${it.ilvl}`);

  if (it.sockets?.length) {
    // Same group = linked ("-"), new group = unlinked (" ")
    let s = "";
    let lastGroup: number | undefined;
    for (const sock of it.sockets as Array<{ group: number; sColour?: string; attr?: string }>) {
      const colour = sock.sColour || "W";
      if (lastGroup === undefined) s += colour;
      else s += (sock.group === lastGroup ? "-" : " ") + colour;
      lastGroup = sock.group;
    }
    lines.push(`Sockets: ${s}`);
  }

  const enchant = it.enchantMods ?? [];
  const scourge = it.scourgeMods ?? [];
  const implicit = it.implicitMods ?? [];
  lines.push(`Implicits: ${enchant.length + scourge.length + implicit.length}`);
  for (const m of enchant) lines.push(`{enchant}${clean(m)}`);
  for (const m of scourge) lines.push(`{scourge}${clean(m)}`);
  for (const m of implicit) lines.push(clean(m));
  for (const m of it.fracturedMods ?? []) lines.push(`{fractured}${clean(m)}`);
  for (const m of it.explicitMods ?? []) lines.push(clean(m));
  for (const m of it.craftedMods ?? []) lines.push(`{crafted}${clean(m)}`);
  if (it.duplicated) lines.push("Mirrored");
  if (it.corrupted) lines.push("Corrupted");
  return lines.join("\n");
}

/** Short trade currency ids -> poe.ninja currency names. */
const CURRENCY_NAMES: Record<string, string> = {
  chaos: "Chaos Orb", divine: "Divine Orb", exalted: "Exalted Orb", alch: "Orb of Alchemy",
  alt: "Orb of Alteration", fusing: "Orb of Fusing", chrom: "Chromatic Orb", jewellers: "Jeweller's Orb",
  chance: "Orb of Chance", vaal: "Vaal Orb", regal: "Regal Orb", gcp: "Gemcutter's Prism",
  scour: "Orb of Scouring", regret: "Orb of Regret", annul: "Orb of Annulment", mirror: "Mirror of Kalandra",
};

/** Listing price in chaos, or undefined when the currency is unknown. */
export function priceInChaos(price: { amount?: number; currency?: string } | undefined, rates: Map<string, number>): number | undefined {
  if (!price || typeof price.amount !== "number" || !price.currency) return undefined;
  if (price.currency === "chaos") return price.amount;
  const name = CURRENCY_NAMES[price.currency];
  const rate = name ? rates.get(name) : undefined;
  return rate ? price.amount * rate : undefined;
}

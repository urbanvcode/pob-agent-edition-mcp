/**
 * Atlas passive tree tools (PoB Agent Edition's Atlas tab).
 * Work in live mode (the user sees the tree change) and headless mode.
 */
import { wrapHandler } from "../utils/errorHandling.js";
import type { PoBLuaApiClient } from "../pobLuaBridge.js";

interface AtlasContext {
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

type AtlasNode = { id: string; name: string; type: string; stats?: string[]; allocated?: boolean; pathCost?: number };

async function call(context: AtlasContext, action: string, params: Record<string, unknown> = {}) {
  await context.ensureLuaClient();
  const client = context.getLuaClient();
  if (!client) throw new Error("PoB is not available");
  const res = await client.liveAction(action, params);
  if (!res.ok) throw new Error(res.error || `${action} failed`);
  return res.result as Record<string, unknown>;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function describe(n: AtlasNode) {
  const kind = n.type === "notable" ? " (notable)" : n.type === "keystone" ? " (KEYSTONE)" : n.type === "wormhole" ? " (gateway)" : "";
  const stats = n.stats?.length ? ` - ${n.stats.join("; ")}` : "";
  return `[${n.id}] ${n.name || "?"}${kind}${stats}`;
}

export async function handleAtlasGet(context: AtlasContext) {
  return wrapHandler("get atlas tree", async () => {
    const r = await call(context, "atlas_get");
    const nodes = (r.nodes as AtlasNode[]) ?? [];
    const special = nodes.filter((n) => n.type !== "normal");
    const lines = [
      `Atlas tree ${String(r.version).replace("_", ".")}: ${r.pointsUsed} / ${r.pointsTotal} points`,
      "",
      special.length ? "Notables and keystones:" : "No notables or keystones allocated yet.",
      ...special.map((n) => "- " + describe(n)),
      "",
      `Small passives: ${nodes.length - special.length}`,
      `Share link: ${r.link}`,
    ];
    return text(lines.join("\n"));
  });
}

export async function handleAtlasSearch(context: AtlasContext, query: string, limit?: number) {
  return wrapHandler("search atlas tree", async () => {
    const res = (await call(context, "atlas_search", { query, limit: limit ?? 25 })) as unknown as AtlasNode[];
    if (!res.length) return text(`No atlas passives match "${query}".`);
    return text([`Atlas passives matching "${query}" (id, cost to reach):`, ...res.map((n) =>
      `- ${describe(n)}${n.allocated ? "  [allocated]" : n.pathCost !== undefined && n.pathCost !== null ? `  [+${n.pathCost} points]` : "  [not reachable]"}`)].join("\n"));
  });
}

export async function handleAtlasEdit(context: AtlasContext, args: { add?: string[]; remove?: string[]; replace?: string[]; link?: string }) {
  return wrapHandler("edit atlas tree", async () => {
    const r = await call(context, "atlas_edit", args as Record<string, unknown>);
    const lines = [`Atlas updated: ${r.pointsUsed} / ${r.pointsTotal} points used.`];
    const added = (r.added as string[]) ?? [];
    const removed = (r.removed as string[]) ?? [];
    const errors = (r.errors as string[]) ?? [];
    if (added.length) lines.push(`Added ${added.length} passives (including path).`);
    if (removed.length) lines.push(`Removed ${removed.length} passives.`);
    if (errors.length) lines.push("Not added:", ...errors.map((e) => `- ${e}`));
    lines.push("Use atlas_get to review; the build must be saved to keep it (live_save_build).");
    return text(lines.join("\n"));
  });
}

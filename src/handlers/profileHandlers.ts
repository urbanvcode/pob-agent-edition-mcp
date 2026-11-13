/**
 * Player profile tools: profile_get, profile_set, profile_mark_learned.
 * The profile lives in AgentEdition.json and is shared with PoB Agent
 * Edition (Options > Agent profile, Overview header chips) and every AI client.
 */
import type { TradeApiClient } from "../services/tradeClient.js";
import {
  getProfile, updateProfile, markLearned, formatProfile,
  type ProfileUpdate,
} from "../utils/playerProfile.js";

function text(t: string) {
  return { content: [{ type: "text", text: t }] };
}

export async function handleProfileGet() {
  const { profile, file, stored } = getProfile();
  return text(formatProfile(profile, file, stored));
}

export interface ProfileContext {
  tradeClient: TradeApiClient | null;
}

/** Check a league name against pathofexile.com's league list (cached by the trade client). */
async function checkLeague(ctx: ProfileContext, league: string): Promise<{ league: string; note?: string }> {
  if (!league || !ctx.tradeClient) return { league, note: league && !ctx.tradeClient ? "League not validated (trade API disabled)." : undefined };
  try {
    const data = await ctx.tradeClient.getLeagues();
    const ids = [...new Set((data.result ?? []).map((l) => l.id))];
    const exact = ids.find((id) => id === league) ?? ids.find((id) => id.toLowerCase() === league.toLowerCase());
    if (exact) return { league: exact };
    throw new Error(`Unknown league "${league}". Leagues on pathofexile.com: ${ids.join(", ")}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Unknown league")) throw err;
    return { league, note: "League not validated (could not reach pathofexile.com)." };
  }
}

export async function handleProfileSet(ctx: ProfileContext, args: ProfileUpdate) {
  const update: ProfileUpdate = { ...args };
  let note: string | undefined;
  if (typeof update.league === "string" && update.league.trim()) {
    const checked = await checkLeague(ctx, update.league.trim());
    update.league = checked.league;
    note = checked.note;
  }
  const { profile, changed, file } = updateProfile(update);
  const lines = [
    changed.length ? `Profile updated: ${changed.join(", ")}.` : "No changes (values already set).",
    ...(note ? [note] : []),
    "PoB Agent Edition shows the new profile in the Overview header within a few seconds.",
    "",
    formatProfile(profile, file, true),
  ];
  return text(lines.join("\n"));
}

export async function handleProfileMarkLearned(topics: string[]) {
  const { profile, added } = markLearned(topics);
  const lines = [
    added.length ? `Marked as explained: ${added.join(", ")}.` : "Already marked as explained.",
    `Learned topics (${profile.learnedTopics.length}): ${profile.learnedTopics.join(", ")}`,
  ];
  if (profile.explanationMode !== "teach") lines.push(`(Explanation mode is ${profile.explanationMode}; learned topics matter most in Teach mode.)`);
  return text(lines.join("\n"));
}


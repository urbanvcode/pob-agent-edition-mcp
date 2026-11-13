/**
 * Player profile shared by every AI client (Claude, Codex, Antigravity, the
 * in-PoB chat) and PoB Agent Edition's Options window.
 *
 * Stored under "profile" in AgentEdition.json next to PoB's Settings.xml
 * (same file as the POESESSID). Keep the schema in sync with
 * PathOfBuilding/src/Agent/Settings.lua (normalizeProfile).
 */
import fs from "fs";
import path from "path";
import { agentSettingsCandidates } from "./poeSession.js";

export type PlayMode = "trade" | "ssf" | "mixed";
export type ExplanationMode = "teach" | "concise" | "deep";
export type Experience = "poe2" | "new" | "poe1";

export interface PlayerProfile {
  playMode: PlayMode;
  league: string;
  currency: { chaos: number; divine: number; other: string; updated?: string };
  goals: string[];
  experience: Experience;
  explanationMode: ExplanationMode;
  learnedTopics: string[];
  updated?: string;
}

export const PLAY_MODES: Record<PlayMode, string> = {
  trade: "Trade",
  ssf: "SSF",
  mixed: "Mixed",
};
export const EXPLANATION_MODES: Record<ExplanationMode, string> = {
  teach: "Teach",
  concise: "Concise",
  deep: "Deep dive",
};
export const EXPERIENCE: Record<Experience, string> = {
  poe2: "Knows PoE2, new to PoE1",
  new: "New to Path of Exile",
  poe1: "Experienced PoE1 player",
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function amount(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const s = str(item);
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out;
}

function oneOf<T extends string>(map: Record<T, string>, v: unknown, fallback: T): T {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(map, v) ? (v as T) : fallback;
}

export function normalizeProfile(raw: unknown): PlayerProfile {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cur = (p.currency && typeof p.currency === "object" ? p.currency : {}) as Record<string, unknown>;
  const profile: PlayerProfile = {
    playMode: oneOf(PLAY_MODES, p.playMode, "trade"),
    league: str(p.league),
    currency: { chaos: amount(cur.chaos), divine: amount(cur.divine), other: str(cur.other) },
    goals: stringList(p.goals),
    experience: oneOf(EXPERIENCE, p.experience, "poe2"),
    explanationMode: oneOf(EXPLANATION_MODES, p.explanationMode, "teach"),
    learnedTopics: stringList(p.learnedTopics),
  };
  if (typeof cur.updated === "string") profile.currency.updated = cur.updated;
  if (typeof p.updated === "string") profile.updated = p.updated;
  return profile;
}

/** The AgentEdition.json to use: the first that exists, else the first whose folder exists. */
export function agentSettingsFile(): string | undefined {
  const candidates = agentSettingsCandidates();
  for (const file of candidates) if (fs.existsSync(file)) return file;
  for (const file of candidates) if (fs.existsSync(path.dirname(file))) return file;
  return undefined;
}

function readSettings(file: string | undefined): Record<string, unknown> {
  if (!file) return {};
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

export function getProfile(): { profile: PlayerProfile; file: string | undefined; stored: boolean } {
  const file = agentSettingsFile();
  const data = readSettings(file);
  return { profile: normalizeProfile(data.profile), file, stored: data.profile !== undefined };
}

/** Write atomically and keep every other key (e.g. POESESSID) untouched. */
function writeProfile(file: string, profile: PlayerProfile): void {
  const data = readSettings(file);
  data.profile = profile;
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    // PoB may hold the file open for a moment on Windows; fall back to a direct write.
    fs.writeFileSync(file, text, "utf8");
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export interface ProfileUpdate {
  playMode?: string;
  league?: string;
  currency?: { chaos?: number; divine?: number; other?: string };
  goals?: string[];
  add_goals?: string[];
  remove_goals?: string[];
  experience?: string;
  explanationMode?: string;
  reset_learned?: boolean;
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function updateProfile(update: ProfileUpdate): { profile: PlayerProfile; changed: string[]; file: string } {
  const file = agentSettingsFile();
  if (!file) throw new Error("PoB user folder not found (Documents/Path of Building). Set POB_AGENT_SETTINGS to the AgentEdition.json path.");
  const current = getProfile().profile;
  const next: PlayerProfile = JSON.parse(JSON.stringify(current));
  const changed: string[] = [];

  if (update.playMode !== undefined) {
    if (!(update.playMode in PLAY_MODES)) throw new Error(`playMode must be one of: ${Object.keys(PLAY_MODES).join(", ")}`);
    next.playMode = update.playMode as PlayMode;
  }
  if (update.explanationMode !== undefined) {
    if (!(update.explanationMode in EXPLANATION_MODES)) throw new Error(`explanationMode must be one of: ${Object.keys(EXPLANATION_MODES).join(", ")}`);
    next.explanationMode = update.explanationMode as ExplanationMode;
  }
  if (update.experience !== undefined) {
    if (!(update.experience in EXPERIENCE)) throw new Error(`experience must be one of: ${Object.keys(EXPERIENCE).join(", ")}`);
    next.experience = update.experience as Experience;
  }
  if (update.league !== undefined) next.league = str(update.league);
  if (update.currency) {
    const c = update.currency;
    if (c.chaos !== undefined) next.currency.chaos = amount(c.chaos);
    if (c.divine !== undefined) next.currency.divine = amount(c.divine);
    if (c.other !== undefined) next.currency.other = str(c.other);
  }
  if (update.goals !== undefined) next.goals = stringList(update.goals);
  if (update.add_goals) next.goals = stringList([...next.goals, ...update.add_goals]);
  if (update.remove_goals) {
    const drop = new Set(update.remove_goals.map((g) => str(g).toLowerCase()));
    next.goals = next.goals.filter((g) => !drop.has(g.toLowerCase()));
  }
  if (update.reset_learned) next.learnedTopics = [];

  const stamp = now();
  for (const key of ["playMode", "league", "goals", "experience", "explanationMode", "learnedTopics"] as const) {
    if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) changed.push(key);
  }
  const { updated: _u, ...curA } = current.currency;
  const { updated: _v, ...curB } = next.currency;
  if (JSON.stringify(curA) !== JSON.stringify(curB)) {
    changed.push("currency");
    next.currency.updated = stamp;
  }
  if (changed.length) {
    next.updated = stamp;
    writeProfile(file, normalizeProfile(next));
  }
  return { profile: normalizeProfile(next), changed, file };
}

export function markLearned(topics: string[]): { profile: PlayerProfile; added: string[]; file: string } {
  const file = agentSettingsFile();
  if (!file) throw new Error("PoB user folder not found (Documents/Path of Building).");
  const profile = getProfile().profile;
  const known = new Set(profile.learnedTopics.map((t) => t.toLowerCase()));
  const added = stringList(topics).filter((t) => !known.has(t.toLowerCase()));
  if (added.length) {
    profile.learnedTopics = [...profile.learnedTopics, ...added];
    profile.updated = now();
    writeProfile(file, profile);
  }
  return { profile, added, file };
}

function currencyText(p: PlayerProfile): string {
  const parts: string[] = [];
  if (p.currency.chaos) parts.push(`${p.currency.chaos}c`);
  if (p.currency.divine) parts.push(`${p.currency.divine} div`);
  if (p.currency.other) parts.push(p.currency.other);
  return parts.length ? parts.join(", ") : "not set";
}

/** One line for live_status and other tool outputs. */
export function profileSummaryLine(p: PlayerProfile): string {
  return `Player profile: ${PLAY_MODES[p.playMode]} | explanations: ${EXPLANATION_MODES[p.explanationMode]} | league: ${p.league || "current league (not set)"} | currency: ${currencyText(p)}${p.goals.length ? ` | goals: ${p.goals.join(", ")}` : ""}. Read profile_get before advising.`;
}

/** How the AI should answer for this profile. Returned by profile_get. */
export function answerRules(p: PlayerProfile): string[] {
  const rules: string[] = [];
  switch (p.playMode) {
    case "trade":
      rules.push("TRADE: upgrades may be bought (instant buyout only, plan_upgrades / trade tools). Budget = currency on hand unless the player says otherwise; mention crafting only when clearly cheaper.");
      break;
    case "ssf":
      rules.push("SSF (Solo Self-Found): the player cannot trade. Do NOT suggest buying items or run trade searches/plan_upgrades for purchases. Suggest crafting (crafting bench, essences, fossils and other methods available this league - check before naming one), farming targets, drop locations, divination cards and vendor recipes; say which uniques are realistic to find. Prices are irrelevant except as a rarity hint.");
      break;
    case "mixed":
      rules.push("MIXED: give both a trade option (instant buyout, price) and a self-found option (craft/farm/drop), each clearly labelled [Trade] / [SSF].");
      break;
  }
  switch (p.explanationMode) {
    case "teach":
      rules.push(`TEACH: the first time a PoE1 mechanic matters, explain it in 1-3 sentences${p.experience === "poe2" ? " and compare it with PoE2 (what is similar, what differs)" : ""}, then call profile_mark_learned with the topic. Do not re-explain topics in learnedTopics; just use the term.`);
      break;
    case "concise":
      rules.push("CONCISE: actions and numbers only. Each recommendation gets at most one short line of why. No mechanic explanations unless asked.");
      break;
    case "deep":
      rules.push("DEEP DIVE: explain the full mechanics and maths behind each recommendation: increased (additive) vs more (multiplicative) modifiers, the effective DPS formula (base x increased x more x crit x speed x hit chance x enemy resistance/penetration), EHP layers (resists, armour/evasion, suppression, block, max hit). Show the PoB numbers used and the calculation steps.");
      break;
  }
  if (p.experience === "poe2") rules.push("EXPERIENCE: knows PoE2, new to PoE1 - relate PoE1 systems to PoE2 where it helps and point out differences.");
  else if (p.experience === "new") rules.push("EXPERIENCE: new to Path of Exile - avoid jargon, define terms, keep steps small.");
  else rules.push("EXPERIENCE: experienced PoE1 player - skip basics, use normal PoE1 terms.");
  if (!p.league) rules.push("LEAGUE: not set - use the current challenge league (get_leagues) and ask if unsure.");
  if (p.goals.length) rules.push(`GOALS: prioritise advice towards: ${p.goals.join("; ")}.`);
  rules.push("Change the profile (profile_set) only when the player asks or states a fact (e.g. 'I have 300c now', 'I'm playing SSF').");
  return rules;
}

export function formatProfile(p: PlayerProfile, file: string | undefined, stored: boolean): string {
  const lines = [
    "=== Player profile ===",
    `Play mode: ${PLAY_MODES[p.playMode]} (${p.playMode})`,
    `League: ${p.league || "(not set - current challenge league)"}`,
    `Currency on hand: ${currencyText(p)}${p.currency.updated ? ` (updated ${p.currency.updated})` : ""}`,
    `Goals: ${p.goals.length ? p.goals.join("; ") : "(none set)"}`,
    `Experience: ${EXPERIENCE[p.experience]} (${p.experience})`,
    `Explanation mode: ${EXPLANATION_MODES[p.explanationMode]} (${p.explanationMode})`,
    `Learned topics (${p.learnedTopics.length}): ${p.learnedTopics.length ? p.learnedTopics.join(", ") : "none yet"}`,
  ];
  if (!stored) lines.push("", "(No profile saved yet - these are the defaults. The player can set it in PoB Agent Edition > Options > Agent profile, or tell you.)");
  lines.push("", "=== How to answer ===", ...answerRules(p).map((r) => `- ${r}`));
  if (file) lines.push("", `Stored in: ${file}`);
  return lines.join("\n");
}

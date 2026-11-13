/**
 * Resolves the pathofexile.com POESESSID used for trade searches.
 *
 * Order: POE_SESSION_ID env var, then PoB Agent Edition's AgentEdition.json
 * (written by its Options window) next to PoB's Settings.xml. The file is
 * re-read when it changes, so a value pasted into PoB works without
 * restarting the AI app.
 */
import fs from "fs";
import os from "os";
import path from "path";

let cache: { file: string; mtimeMs: number; value: string | undefined } | undefined;

/** AgentEdition.json locations in priority order (shared with playerProfile.ts). */
export function agentSettingsCandidates(): string[] {
  const files: string[] = [];
  if (process.env.POB_AGENT_SETTINGS) files.push(process.env.POB_AGENT_SETTINGS);
  // POB_DIRECTORY is the Builds folder; the user folder is its parent.
  if (process.env.POB_DIRECTORY) files.push(path.join(path.dirname(path.resolve(process.env.POB_DIRECTORY)), "AgentEdition.json"));
  files.push(path.join(os.homedir(), "Documents", "Path of Building", "AgentEdition.json"));
  return files;
}

function readFromAgentSettings(): string | undefined {
  for (const file of agentSettingsCandidates()) {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { continue; }
    if (cache && cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.value;
    let value: string | undefined;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as { POESESSID?: unknown };
      if (typeof data.POESESSID === "string" && /^[0-9a-zA-Z]+$/.test(data.POESESSID)) value = data.POESESSID;
    } catch { value = undefined; }
    cache = { file, mtimeMs: stat.mtimeMs, value };
    return value;
  }
  return undefined;
}

export function getPoeSessionId(): string | undefined {
  const fromEnv = process.env.POE_SESSION_ID?.trim();
  if (fromEnv) return fromEnv;
  return readFromAgentSettings();
}

export function poeSessionSource(): "env" | "pob" | "none" {
  if (process.env.POE_SESSION_ID?.trim()) return "env";
  return readFromAgentSettings() ? "pob" : "none";
}

/**
 * Live-window tools for PoB Agent Edition.
 *
 * These only work when the bridge is connected to a running Agent Edition
 * window (POB_LIVE=auto|only). In headless mode they explain how to switch.
 */
import path from "path";
import { wrapHandler } from "../utils/errorHandling.js";
import type { PoBLuaApiClient } from "../pobLuaBridge.js";
import { resolveBuildFile } from "../utils/pathSanitizer.js";

interface LiveContext {
  pobDirectory: string;
  getLuaClient: () => PoBLuaApiClient | null;
  ensureLuaClient: () => Promise<void>;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

async function liveClient(context: LiveContext): Promise<PoBLuaApiClient> {
  await context.ensureLuaClient();
  const client = context.getLuaClient();
  if (!client) throw new Error("Lua client not initialized");
  if (!client.isLive()) {
    throw new Error(
      "Not connected to a live PoB window (using the headless engine). Start PoB Agent Edition, " +
      "then run lua_stop followed by lua_start to connect to it.",
    );
  }
  return client;
}

export async function handleLiveStatus(context: LiveContext) {
  return wrapHandler("get live PoB status", async () => {
    await context.ensureLuaClient();
    const client = context.getLuaClient();
    if (!client) throw new Error("Lua client not initialized");
    if (!client.isLive()) {
      return text("Mode: headless engine (no live PoB window connected).\nStart PoB Agent Edition, then lua_stop + lua_start to drive the window you see.");
    }
    const s = await client.getLiveState();
    if (s.mode !== "BUILD") {
      return text(`Mode: live PoB window\nWindow shows: ${s.mode} (build list). Open a build with live_open_build.`);
    }
    return text([
      "Mode: live PoB window",
      `Build: ${s.buildName ?? "Unnamed"}${s.unsaved ? " (unsaved changes)" : ""}`,
      `File: ${s.file ?? "(not saved to a file yet)"}`,
      `Character: level ${s.level ?? "?"} ${s.className ?? "?"}${s.ascendancy ? ` (${s.ascendancy})` : ""}`,
      `Tab: ${s.viewMode ?? "?"}`,
    ].join("\n"));
  });
}

export async function handleLiveOpenBuild(context: LiveContext, buildName: string) {
  return wrapHandler("open build in live PoB", async () => {
    const client = await liveClient(context);
    const file = path.isAbsolute(buildName) ? buildName : resolveBuildFile(buildName, context.pobDirectory);
    const res = await client.liveAction("open_build_file", { path: file });
    if (!res.ok) throw new Error(res.error || "open_build_file failed");
    return text(`Opened "${res.name ?? buildName}" in the PoB window.\nFile: ${res.file ?? file}`);
  });
}

export async function handleLiveSaveBuild(context: LiveContext, buildName?: string) {
  return wrapHandler("save live PoB build", async () => {
    const client = await liveClient(context);
    const params: Record<string, unknown> = {};
    if (buildName) {
      const file = path.isAbsolute(buildName) ? buildName : resolveBuildFile(buildName, context.pobDirectory);
      params.path = file;
    }
    const res = await client.liveAction("save_live_build", params);
    if (!res.ok) throw new Error(res.error || "save_live_build failed");
    return text(`Saved the PoB window's build to ${res.file}.`);
  });
}

export async function handleLiveSetView(context: LiveContext, view: string) {
  return wrapHandler("switch PoB tab", async () => {
    const client = await liveClient(context);
    const res = await client.liveAction("set_view", { view });
    if (!res.ok) throw new Error(res.error || "set_view failed");
    return text(`PoB window switched to the ${res.view} tab.`);
  });
}

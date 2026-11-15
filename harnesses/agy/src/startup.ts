import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"

import { geminiHome } from "./home.js"
import { pluginId } from "./plugin.js"

/**
 * Its sign-in screen, without a Gemini API key or a login: "Select login method:" under
 * "You are currently not signed in." (probed 2026-11-15, 1.5.7; fixtures/startup.probe.json,
 * `signIn`). Its status line says `authenticating` behind it too, which names it first.
 */
export const heldScreen: NonNullable<Harness["heldScreen"]> = (rows) =>
  rows.some((row) => /You are currently not signed in\.\s*$/.test(row)) ? "sign-in" : undefined

const readJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether Antigravity loads Novadeck's plugin, whose hooks it runs with no review once the
 * folder is trusted: off where the person disabled it (`agy plugin disable`, or the settings'
 * plugin section), which `~/.gemini/config/config.json` records as `plugins.novadeck.enabled`
 * false, or where no entry there and the plugin's own `plugin.json` declares `disabled`. A
 * disabled plugin's hooks never run, though its status line, the person's own settings', says
 * its prompt shows (probed 2026-11-15, 1.5.7). Read, never written.
 */
export const hooksTrusted: NonNullable<Harness["hooksTrusted"]> = async (where) => {
  const config = join(geminiHome(where), "config")
  const [settings, plugin] = await Promise.all([
    readJson(join(config, "config.json")),
    readJson(join(config, "plugins", pluginId, "plugin.json")),
  ])
  const entry = (settings?.plugins as Record<string, { enabled?: unknown }> | undefined)?.[pluginId]
  if (typeof entry?.enabled === "boolean") return entry.enabled
  return plugin?.disabled !== true
}

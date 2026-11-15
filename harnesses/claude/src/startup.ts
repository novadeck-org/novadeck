import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { manifest, marketplace } from "@novadeck/harness-core/plugin"

import { claudeHome } from "./home.js"

/** Novadeck's plugin as Claude Code's `enabledPlugins` names it. */
const pluginId = `${manifest.name}@${marketplace.name}`

/**
 * Its sign-in screen, at a first run without a key, after the theme picker and a
 * connectivity check: "Select login method:" over its numbered choices (probed 2026-11-15,
 * 2.1.316 and 2.1.325; fixtures/startup.probe.json, `signIn`).
 */
const signInScreen = /^\s*Select login method:\s*$/

export const heldScreen: NonNullable<Harness["heldScreen"]> = (rows) =>
  rows.some((row) => signInScreen.test(row)) ? "sign-in" : undefined

/**
 * Without a key, once onboarding is done, it shows no sign-in screen: its prompt draws, its
 * SessionStart binds, and a footer above the box, at its right edge, reads "Not logged in ·
 * Run /login" until the person signs in; a prompt there fails with "Not logged in · Please
 * run /login" (probed 2026-11-15, 2.1.316 and 2.1.325; fixtures/startup.probe.json,
 * `signedOut`). The footer stands alone on its row, which a reply quoting it never does.
 */
const signedOutFooter = /^\s{8,}Not logged in · Run \/login\s*$/

export const signedOut: NonNullable<Harness["signedOut"]> = (rows) =>
  rows.some((row) => signedOutFooter.test(row))

type Settings = {
  readonly disableAllHooks?: unknown
  readonly allowManagedHooksOnly?: unknown
  readonly enabledPlugins?: Record<string, unknown>
}

const readSettings = async (path: string): Promise<Settings | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as Settings) : undefined
  } catch {
    // None there, or one Claude Code ignores as well.
    return undefined
  }
}

/** Where an administrator's managed settings are, which outrank every other scope. */
const managedSettings = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string =>
  platform === "win32"
    ? join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json")
    : platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : "/etc/claude-code/managed-settings.json"

/**
 * Whether Claude Code runs Novadeck's hooks in `cwd`, as its settings say, read and never
 * written: off where the settings scope that decides sets `disableAllHooks` (as the
 * project's settings, `.claude/settings.json` or `.local.json`, may) or turns Novadeck's
 * plugin off in `enabledPlugins`, or where managed settings allow only managed hooks. A
 * scope outranks those below it: managed, the project's local, the project's, the
 * person's. With either off it starts to its prompt as ever, its SessionStart never runs, and
 * nothing on its screen says so (probed 2026-11-15, 2.1.316: `disableAllHooks` in the
 * person's settings, the plugin disabled in the project's). Settings given with `--settings`
 * aren't read: Novadeck's own carry only its status line.
 */
export const hooksTrusted: NonNullable<Harness["hooksTrusted"]> = async (where, cwd) => {
  const [managed, local, project, user] = await Promise.all([
    readSettings(managedSettings(where.platform, where.env)),
    readSettings(join(cwd, ".claude", "settings.local.json")),
    readSettings(join(cwd, ".claude", "settings.json")),
    readSettings(join(claudeHome(where), "settings.json")),
  ])
  if (managed?.allowManagedHooksOnly === true) return false
  const scopes = [managed, local, project, user]
  const decides = <T>(read: (settings: Settings) => T | undefined): T | undefined =>
    scopes.map((settings) => (settings ? read(settings) : undefined)).find((v) => v !== undefined)
  const disabled = decides((settings) =>
    typeof settings.disableAllHooks === "boolean" ? settings.disableAllHooks : undefined,
  )
  const enabled = decides((settings) => {
    const value = settings.enabledPlugins?.[pluginId]
    return typeof value === "boolean" ? value : undefined
  })
  return disabled !== true && enabled !== false
}

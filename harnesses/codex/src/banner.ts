import { versionName } from "@novadeck/harness-core/decode"

// Codex's banner, drawn at the top of each process's screen: "  >_ OpenAI Codex (v0.166.0)"
// (0.165.0 and 0.166.0, a fresh start and a resume alike; the conversation scrolls it away
// as it grows).
const banner = /^\s*>_ OpenAI Codex \(v([^)\s]+)\)\s*$/

/**
 * The version of Codex the screen's banner names: the release running, which its rollout
 * cannot say of a session a newer release resumed. Undefined where the banner is not on the
 * screen.
 */
export const bannerVersion = (rows: readonly string[]): string | undefined => {
  for (const row of rows) {
    const version = versionName(banner.exec(row)?.[1])
    if (version !== undefined) return version
  }
  return undefined
}

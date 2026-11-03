import { versionName } from "@novadeck/harness-core/decode"

// Codex's banner, drawn at the top of each process's screen: "  >_ OpenAI Codex (v0.166.0)"
// (0.165.0 and 0.166.0, a fresh start and a resume alike). Its TUI uses the alternate
// screen, where a resumed conversation is replayed over the banner (drawn about 350 ms after
// the start, covered about 150 ms later).
const banner = /^\s*>_ OpenAI Codex \(v([^)\s]+)\)\s*$/

/** What the banner's line starts with, within its first columns (`Harness.screenMarker`). */
export const bannerMarker = { text: ">_", columns: 8 } as const

/**
 * The version of Codex the screen's banner names: the release running, which its rollout
 * cannot say of a session a newer release resumed. Undefined where the banner is not on the
 * screen. Where more than one shows, as an inline screen may keep an earlier process's
 * above, the lowest is the one running.
 */
export const bannerVersion = (rows: readonly string[]): string | undefined => {
  for (const row of rows.toReversed()) {
    const version = versionName(banner.exec(row)?.[1])
    if (version !== undefined) return version
  }
  return undefined
}

import type { ScreenText } from "@novadeck/emulator/headless"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Record } from "../record.js"
import { bannerDrawn, bannerSeen, bannerWindowMs } from "./banners.js"

// A terminal as the banner reader sees it: its screen's buffers, its pty and its binding.
const terminal = () => {
  const alternate = {}
  const normal = {}
  const buffer = { active: alternate as object, alternate, normal }
  const record = { bound: null, terminal: { screen: { buffer }, pty: {} } }
  return { record: record as unknown as Record, buffer, normal }
}

const banner = (version: string): ScreenText =>
  ({ rows: ["", `  >_ OpenAI Codex (v${version})`, ""] }) as unknown as ScreenText

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("a starting TUI's banner", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }))
  afterEach(() => vi.useRealTimers())

  it("is read while the alternate screen starts, and kept for the binding", async () => {
    const { record } = terminal()
    const screenOf = vi.fn<() => Promise<ScreenText>>(async () => banner("0.166.0"))
    bannerDrawn(record, screenOf)
    await settled()
    expect(bannerSeen(record, "codex")).toBe("0.166.0")
    expect(bannerSeen(record, "claude")).toBeUndefined()
  })

  it("is read no more once found, nor past the window, as an editor or htop runs on", async () => {
    const { record } = terminal()
    const found = vi.fn<() => Promise<ScreenText>>(async () => banner("0.166.0"))
    bannerDrawn(record, found)
    await settled()
    bannerDrawn(record, found)
    await settled()
    expect(found).toHaveBeenCalledTimes(1)

    const other = terminal()
    const blank = vi.fn<() => Promise<ScreenText>>(
      async () => ({ rows: ["top", "htop"] }) as unknown as ScreenText,
    )
    bannerDrawn(other.record, blank)
    await settled()
    vi.setSystemTime(Date.now() + bannerWindowMs + 1)
    bannerDrawn(other.record, blank)
    bannerDrawn(other.record, blank)
    await settled()
    expect(blank).toHaveBeenCalledTimes(1)
  })

  it("is forgotten on leaving the alternate screen, and looked for again on the next start", async () => {
    const { record, buffer, normal } = terminal()
    const screenOf = vi.fn<() => Promise<ScreenText>>(async () => banner("0.166.0"))
    bannerDrawn(record, screenOf)
    await settled()
    buffer.active = normal
    bannerDrawn(record, screenOf)
    expect(bannerSeen(record, "codex")).toBeUndefined()
    buffer.active = buffer.alternate
    vi.setSystemTime(Date.now() + bannerWindowMs + 1)
    bannerDrawn(record, screenOf)
    await settled()
    expect(bannerSeen(record, "codex")).toBe("0.166.0")
  })
})

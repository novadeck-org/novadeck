import { aloneInWindows } from "@novadeck/core/desktop/project-windows"
import type { AgentConnection, Backend } from "@novadeck/core/port"
import { createStore } from "@novadeck/core/store"

import type { LostToast } from "../inbox/InboxToasts"
import { describe, expect, it } from "../test"
import { lostTitle, watchLostToasts } from "./lost-toasts"
import type { UiStore } from "./ui-store"

const agent = (
  name: AgentConnection["agent"],
  extra: Partial<AgentConnection> = {},
): AgentConnection => ({ agent: name, available: true, connected: true, busy: false, ...extra })
const lost = (name: AgentConnection["agent"]): AgentConnection =>
  agent(name, { connected: false, lost: true })

const setup = (initial: AgentConnection[], voice = true) => {
  const state = createStore<readonly AgentConnection[]>(initial)
  const ui = {
    getSnapshot: () => ({ windows: { ...aloneInWindows, voice } }),
  } as unknown as UiStore
  const shown: LostToast[] = []
  const closed: string[] = []
  const reconnected: string[] = []
  const opened: string[] = []
  const stop = watchLostToasts(
    { state } as unknown as Backend["agents"],
    ui,
    { show: (toast) => void shown.push(toast), close: (name) => void closed.push(name) },
    { reconnect: (name) => void reconnected.push(name), open: (name) => void opened.push(name) },
  )
  return { state, shown, closed, reconnected, opened, stop }
}

describe("the toast of a lost agent", () => {
  it("tells of an agent already lost when the app starts, in the harness's own name", () => {
    const { shown, stop } = setup([agent("codex"), lost("claude")])
    expect(shown.map((toast) => toast.title)).toEqual(["Claude Code is no longer connected"])
    expect(lostTitle("agy")).not.toMatch(/Claude/)
    stop()
  })

  it("tells once per loss, and again only after the agent was connected in between", () => {
    const { state, shown, stop } = setup([agent("claude")])
    state.update(() => [lost("claude")])
    state.update(() => [{ ...lost("claude"), busy: true }])
    state.update(() => [lost("claude")])
    expect(shown).toHaveLength(1)
    state.update(() => [agent("claude")])
    state.update(() => [lost("claude")])
    expect(shown).toHaveLength(2)
    stop()
  })

  it("takes the toast away once the agent is connected, and says nothing of one just off", () => {
    const { state, shown, closed, stop } = setup([agent("claude", { connected: false })])
    expect(shown).toEqual([])
    state.update(() => [lost("claude")])
    state.update(() => [agent("claude")])
    expect(closed).toContain("claude")
    stop()
  })

  it("reconnects or opens Preferences from the toast, taking it away", () => {
    const { shown, closed, reconnected, opened, stop } = setup([lost("claude")])
    shown[0]!.reconnect()
    shown[0]!.open()
    expect(reconnected).toEqual(["claude"])
    expect(opened).toEqual(["claude"])
    expect(closed).toEqual(["claude", "claude"])
    stop()
  })

  it("is told by the window the person used last alone, and not again when another gets the voice", () => {
    const quiet = setup([lost("claude")], false)
    expect(quiet.shown).toEqual([])
    quiet.state.update(() => [lost("claude"), agent("codex")])
    expect(quiet.shown).toEqual([])
    quiet.stop()
  })
})

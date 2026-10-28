import type { WorkspaceAction } from "@novadeck/core/state"
import { createWorkspaceStore } from "@novadeck/core/store"
import { itemFixture, workspaceFixture } from "@novadeck/core/testing"
import { appearance } from "@novadeck/core/testing"

import type { ShowWaiting } from "../inbox/InboxToasts"
import { moreWords } from "../inbox/InboxToasts"
import { context, describe, expect, it } from "../test"
import { focusWhenReady, watchShowToasts } from "./show-toasts"
import { createUiStore, initialUi, type UiState } from "./ui-store"

const target = { projectId: "project", workspaceSessionId: "initial" }
const page = itemFixture("page", "02", { openAsked: true, name: "Order status" })

const setup = () => {
  const workspace = createWorkspaceStore(workspaceFixture())
  const ui = createUiStore(
    initialUi({
      location: {
        route: {
          projectId: "project",
          sessionId: "initial",
          view: "grid",
          terminal: "01",
          panel: "terminals",
          dialog: null,
          section: "general",
        },
        dialogDepth: 0,
        navigationType: "POP",
      },
      preferences: {
        fontSize: 13,
        enabledViews: ["grid"],
        appearance,
        notifyNeeds: true,
        notifyFinished: true,
        sound: true,
        soundVolume: 0.6,
        soundChoice: "theme",
        ligatures: false,
        chatView: false,
      },
    }),
  )
  const shown: ShowWaiting[] = []
  const closed: string[] = []
  const stop = watchShowToasts(
    workspace,
    ui,
    { show: (waiting) => void shown.push(waiting), close: (id) => void closed.push(id) },
    { desktop: () => true },
  )
  const dispatch = (...actions: WorkspaceAction[]) => actions.forEach(workspace.dispatch)
  const change = (patch: (state: UiState) => UiState) => ui.update(patch)
  return { dispatch, change, shown, closed, stop }
}

describe("toasts for what waits to open", () => {
  context("when an agent asks to show something on a terminal the person isn't on", () => {
    it("tells who wants to show what, once", () => {
      const { dispatch, shown, stop } = setup()
      dispatch({ type: "item/upsert", target, item: page })
      expect(shown).toEqual([
        expect.objectContaining({ itemId: page.id, itemName: "Order status", terminalId: "02" }),
      ])
      dispatch({ type: "terminal/rename", target, terminalId: "02", name: "Cart" })
      expect(shown).toHaveLength(1)
      stop()
    })

    it("tells again when it is shown again", () => {
      const { dispatch, shown, stop } = setup()
      dispatch(
        { type: "item/upsert", target, item: page },
        { type: "item/upsert", target, item: { ...page, version: 2 } },
      )
      expect(shown).toHaveLength(2)
      stop()
    })

    it("takes the toast away once the terminal is selected and the item opens", () => {
      const { dispatch, shown, closed, stop } = setup()
      dispatch({ type: "item/upsert", target, item: page })
      expect(closed).toEqual([])
      dispatch({ type: "terminal/select", target, terminalId: "02" })
      expect(closed).toEqual([page.id])
      expect(shown).toHaveLength(1)
      stop()
    })

    it("takes it away when the person closes the item first", () => {
      const { dispatch, closed, stop } = setup()
      dispatch(
        { type: "item/upsert", target, item: page },
        { type: "item/close", target, itemId: page.id },
      )
      expect(closed).toEqual([page.id])
      stop()
    })

    it("says nothing while the page hasn't their focus, until it has", () => {
      const { dispatch, change, shown, stop } = setup()
      change((state) => ({ ...state, pageFocused: false }))
      dispatch({ type: "item/upsert", target, item: page })
      expect(shown).toEqual([])
      change((state) => ({ ...state, pageFocused: true }))
      expect(shown).toHaveLength(1)
      stop()
    })

    it("says nothing for what opens at once", () => {
      const { dispatch, shown, stop } = setup()
      dispatch({
        type: "item/upsert",
        target,
        item: itemFixture("here", "01", { openAsked: true }),
      })
      expect(shown).toEqual([])
      stop()
    })
  })
})

describe("focusing the terminal the person was taken to", () => {
  it("tries each frame until the terminal's input takes focus", () => {
    const frames: (() => void)[] = []
    const asked: string[] = []
    focusWhenReady(
      "02",
      (id) => (asked.push(id), asked.length === 3),
      (next) => frames.push(next),
    )
    while (frames.length) frames.shift()!()
    expect(asked).toEqual(["02", "02", "02"])
  })

  it("gives up after its tries, and stops when told", () => {
    const frames: (() => void)[] = []
    let asked = 0
    focusWhenReady(
      "02",
      () => (asked++, false),
      (next) => frames.push(next),
      () => {},
      3,
    )
    while (frames.length) frames.shift()!()
    expect(asked).toBe(3)
  })
})

describe("what the toasts past the shown few say", () => {
  it("counts only the Inbox's as in the Inbox", () => {
    expect(moreWords(3, 2)).toBe("2 more in the Inbox")
    expect(moreWords(2, 0)).toBe("2 more")
  })
})

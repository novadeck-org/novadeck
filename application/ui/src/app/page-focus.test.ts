import { describe, expect, it } from "../test"
import { appearance, workspaceFixture } from "../test/fixtures"
import { watchPageFocus } from "./page-focus"
import { createUiStore, initialUi } from "./ui-store"

// A window as the watch sees it: whether its document has focus and shows, the events
// that say either changed, and timers it runs when told.
const page = () => {
  const view = new EventTarget()
  const document = Object.assign(new EventTarget(), {
    focused: true,
    visibilityState: "visible" as DocumentVisibilityState,
    hasFocus: () => document.focused,
  })
  const timers: (() => void)[] = []
  Object.assign(view, {
    document,
    setTimeout: (run: () => void) => timers.push(run),
    clearTimeout: () => {},
  })
  return {
    view: view as unknown as Window,
    document,
    settle: () => timers.splice(0).forEach((run) => run()),
  }
}

const ui = () =>
  createUiStore(
    initialUi({
      location: {
        route: {
          projectId: workspaceFixture().activeProjectId,
          sessionId: "initial",
          view: "focus",
          terminal: "",
          panel: "terminals",
          dialog: null,
          section: "general",
        },
        dialogDepth: 0,
        navigationType: "POP",
      },
      preferences: {
        fontSize: 13,
        enabledViews: ["focus"],
        appearance,
        notifyFinished: true,
        ligatures: false,
        chatView: false,
      },
    }),
  )

describe("the page's focus", () => {
  it("follows the window's focus", () => {
    const store = ui()
    const { view, document, settle } = page()
    document.focused = false
    const stop = watchPageFocus(store, view)
    expect(store.getSnapshot().pageFocused).toBe(false)
    document.focused = true
    view.dispatchEvent(new Event("focus"))
    expect(store.getSnapshot().pageFocused).toBe(true)
    document.focused = false
    view.dispatchEvent(new Event("blur"))
    // A blur is looked at once it settles.
    expect(store.getSnapshot().pageFocused).toBe(true)
    settle()
    expect(store.getSnapshot().pageFocused).toBe(false)
    stop()
  })

  it("stays focused when focus moved into a frame of the page", () => {
    const store = ui()
    const { view, settle } = page()
    const stop = watchPageFocus(store, view)
    // The document still has focus, inside its frame, once the blur settles.
    view.dispatchEvent(new Event("blur"))
    settle()
    expect(store.getSnapshot().pageFocused).toBe(true)
    stop()
  })

  it("is lost while the page doesn't show, as in a minimized window", () => {
    const store = ui()
    const { view, document } = page()
    const stop = watchPageFocus(store, view)
    document.visibilityState = "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
    expect(store.getSnapshot().pageFocused).toBe(false)
    stop()
    document.visibilityState = "visible"
    document.dispatchEvent(new Event("visibilitychange"))
    expect(store.getSnapshot().pageFocused).toBe(false)
  })
})

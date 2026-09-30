import { afterEach, vi } from "vitest"

import {
  keymapFor,
  routeKey,
  type KeyInput,
  type KeyPhase,
  type KeyTarget,
} from "../../interaction/keymap"
import type { CanvasHandle } from "../../layouts/canvas/types"
import { context, describe, expect, it } from "../../test"
import { openCommands, type CommandsOptions } from "../../test/commands"
import { workspaceFixture } from "../../test/fixtures"
import { createKeyCommands, keyState, runKey } from "./keys"

type Press = Partial<Omit<KeyInput, "target">> & { target?: Partial<KeyTarget> }

const nowhere: KeyTarget = {
  editing: false,
  terminalInput: false,
  rename: false,
  viewSwitch: false,
  navigationControl: false,
  canvasNode: false,
  terminalTab: false,
  switcherClose: false,
  zenDock: false,
  companion: false,
}

// The app's key handling on other platforms, over real stores and commands.
const openKeys = (options?: CommandsOptions) => {
  const app = openCommands(options)
  const keys = createKeyCommands(app.commands, app.context)
  const bindings = keymapFor("other")
  const send = (phase: KeyPhase, { target, ...press }: Press): "handled" | "passed" => {
    const input: KeyInput = {
      key: "",
      code: "",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      repeat: false,
      composing: false,
      defaultPrevented: false,
      ...press,
      target: { ...nowhere, ...target },
    }
    const environment = { overlayOpen: () => false, tabInteraction: () => false }
    const candidates = routeKey(
      bindings,
      phase,
      input,
      keyState(app.context, app.commands),
      environment,
    )
    return runKey(keys, candidates, phase, input)
  }
  // A keydown goes through capture first and reaches bubble only when capture passes it.
  const keydown = (press: Press): "handled" | "passed" =>
    send("capture", press) === "handled" ? "handled" : send("bubble", press)
  return {
    ...app,
    keydown,
    keyup: (press: Press) => send("keyup", press),
    blur: () => send("blur", {}),
  }
}

afterEach(() => void vi.useRealTimers())

describe("key commands", () => {
  context("when pressing Escape", () => {
    it("returns Canvas to its origin before touching the selection, but not on repeat", () => {
      let returns = 0
      const canvas: CanvasHandle = { returnToOrigin: () => (returns++, true) }
      const app = openKeys({
        workspace: workspaceFixture({ view: "canvas" }),
        url: "/projects/project/sessions/initial/canvas?terminal=01",
        canvas,
      })
      expect(app.keydown({ key: "Escape" })).toBe("handled")
      expect(returns).toBe(1)
      expect(app.state().selected).toBe("01")
      expect(app.keydown({ key: "Escape", repeat: true })).toBe("handled")
      expect(returns).toBe(1)
      expect(app.state().selected).toBe("01")
    })

    it("clears the selection, keeping it as the Focus preview, then hides the sidebar", () => {
      const app = openKeys({
        workspace: workspaceFixture({ view: "focus" }),
        url: "/projects/project/sessions/initial/focus?terminal=02",
      })
      app.commands.setKeyboardFocus({ id: "02", view: "focus" })
      expect(app.keydown({ key: "Escape" })).toBe("handled")
      expect(app.state().selected).toBe("")
      expect(app.shell()).toMatchObject({
        focusPreview: { context: "project/initial", id: "02" },
        keyboardFocus: null,
      })
      expect(app.effects).toContain("focus viewport")
      expect(app.keydown({ key: "Escape" })).toBe("handled")
      expect(app.shell().sidebarCollapsed).toBe(true)
      expect(app.effects.at(-1)).toBe("focus terminals toggle")
      expect(app.keydown({ key: "Escape" })).toBe("passed")
    })
  })

  context("when holding Control to switch recent terminals", () => {
    it("cycles on each Tab and switches on release, handing focus back to terminal input", () => {
      const app = openKeys({ workspace: workspaceFixture({ terminals: 3 }) })
      app.commands.select("02")
      app.commands.select("03")
      const tab = { key: "Tab", ctrlKey: true, target: { editing: true, terminalInput: true } }
      expect(app.keydown(tab)).toBe("handled")
      expect(app.ui.getSnapshot().recent.switcher).toMatchObject({ index: 1, mode: "held" })
      expect(app.keydown({ ...tab, repeat: true })).toBe("handled")
      expect(app.ui.getSnapshot().recent.switcher?.index).toBe(2)
      expect(app.keydown({ key: "ArrowUp", ctrlKey: true })).toBe("handled")
      expect(app.keyup({ key: "Control" })).toBe("passed")
      expect(app.ui.getSnapshot().recent.switcher).toBeNull()
      expect(app.state().selected).toBe("02")
      expect(app.shell().keyboardFocus).toEqual({ id: "02", view: "grid" })
    })

    it("lets Ctrl+Tab through with fewer than two terminals", () => {
      const app = openKeys({ workspace: workspaceFixture({ terminals: 1 }) })
      expect(app.keydown({ key: "Tab", ctrlKey: true })).toBe("passed")
      expect(app.ui.getSnapshot().recent.switcher).toBeNull()
    })

    it("cancels when the window loses focus", () => {
      const app = openKeys()
      app.keydown({ key: "Tab", ctrlKey: true })
      app.blur()
      expect(app.ui.getSnapshot().recent.switcher).toBeNull()
      expect(app.state().selected).toBe("01")
    })
  })

  context("when the switcher was opened with a click", () => {
    it("chooses with Enter unless its close button has focus", () => {
      const app = openKeys()
      app.commands.openSwitcher("01", { isConnected: true, focus: () => {} })
      expect(app.keydown({ key: "Enter", target: { switcherClose: true } })).toBe("passed")
      expect(app.keydown({ key: "ArrowDown" })).toBe("handled")
      expect(app.keydown({ key: "Enter" })).toBe("handled")
      expect(app.state().selected).toBe("02")
      expect(app.shell().keyboardFocus).toEqual({ id: "02", view: "grid" })
    })

    it("closes with Escape and returns focus to the button after a microtask", () => {
      const app = openKeys()
      const focused: string[] = []
      app.commands.openSwitcher("01", { isConnected: true, focus: () => focused.push("trigger") })
      expect(app.keydown({ key: "Escape" })).toBe("handled")
      expect(app.ui.getSnapshot().recent.switcher).toBeNull()
      expect(focused).toEqual([])
      app.flush()
      expect(focused).toEqual(["trigger"])
    })
  })

  context("when pressing Up and Down", () => {
    it("wraps around and starts from either end with nothing selected", () => {
      const app = openKeys({ workspace: workspaceFixture({ terminals: 3 }) })
      app.keydown({ key: "ArrowUp" })
      expect(app.state().selected).toBe("03")
      app.keydown({ key: "ArrowDown" })
      expect(app.state().selected).toBe("01")
      app.commands.setSelected("")
      app.keydown({ key: "ArrowUp" })
      expect(app.state().selected).toBe("03")
      app.commands.setSelected("")
      app.keydown({ key: "ArrowDown" })
      expect(app.state().selected).toBe("01")
    })

    it("moves focus to the terminal's tab only from a tab or the view switch with Terminals showing", () => {
      const app = openKeys()
      app.keydown({ key: "ArrowDown", target: { terminalTab: true } })
      expect(app.effects).toContain("focus tab 02")
      app.keydown({ key: "ArrowDown" })
      expect(app.effects.filter((effect) => effect.startsWith("focus tab"))).toEqual([
        "focus tab 02",
      ])
      app.commands.hideSidebar()
      app.keydown({ key: "ArrowDown", target: { viewSwitch: true, navigationControl: true } })
      expect(app.effects.filter((effect) => effect.startsWith("focus tab"))).toEqual([
        "focus tab 02",
      ])
    })

    it("asks Canvas to focus the next node when pressed on a node", () => {
      const app = openKeys({
        workspace: workspaceFixture({ view: "canvas" }),
        url: "/projects/project/sessions/initial/canvas?terminal=01",
      })
      app.keydown({ key: "ArrowDown", target: { canvasNode: true } })
      expect(app.shell().canvasKeyboardFocus).toMatchObject({ id: "02" })
    })

    it("keeps arrows even when there are no terminals", () => {
      const app = openKeys({ workspace: workspaceFixture({ terminals: 0 }) })
      expect(app.keydown({ key: "ArrowDown" })).toBe("handled")
    })
  })

  context("when pressing Left and Right", () => {
    it("steps through the enabled views, wrapping and skipping disabled ones", () => {
      const app = openKeys({
        preferences: { fontSize: 13, enabledViews: ["focus", "canvas"] },
        workspace: workspaceFixture({ view: "canvas" }),
        url: "/projects/project/sessions/initial/canvas?terminal=01",
      })
      app.keydown({ key: "ArrowRight" })
      expect(app.state().view).toBe("focus")
      app.keydown({ key: "ArrowLeft" })
      expect(app.state().view).toBe("canvas")
    })
  })

  context("when toggling Focus", () => {
    it("lets the key through when the destination view is disabled", () => {
      const app = openKeys({ preferences: { fontSize: 13, enabledViews: ["grid", "canvas"] } })
      expect(app.keydown({ key: "f" })).toBe("passed")
      expect(app.keydown({ key: "Enter", ctrlKey: true, shiftKey: true })).toBe("passed")
    })

    it("keeps typing focus in the terminal when the chord comes from its input", () => {
      const app = openKeys()
      const chord = { key: "Enter", ctrlKey: true, shiftKey: true }
      app.keydown({ ...chord, target: { editing: true, terminalInput: true } })
      expect(app.state().view).toBe("focus")
      expect(app.shell().keyboardFocus).toEqual({ id: "01", view: "focus" })
      expect(app.keydown({ ...chord, repeat: true })).toBe("handled")
      expect(app.state().view).toBe("focus")
    })
  })

  context("when renaming or closing from the keyboard", () => {
    it("lets Delete and F2 through when no terminal is targeted", () => {
      const app = openKeys()
      app.commands.setSelected("")
      expect(app.keydown({ key: "Delete" })).toBe("passed")
      expect(app.keydown({ key: "F2" })).toBe("passed")
    })

    it("falls back to the terminal Focus shows", () => {
      const app = openKeys({
        workspace: workspaceFixture({ view: "focus" }),
        url: "/projects/project/sessions/initial/focus?terminal=",
      })
      expect(app.keydown({ key: "F2" })).toBe("handled")
      expect(app.ui.getSnapshot().rename).toMatchObject({ id: "01", origin: "sidebar" })
      expect(app.keydown({ key: "Delete" })).toBe("handled")
      expect(app.state().roster.terminals.map((terminal) => terminal.id)).toEqual(["02"])
    })
  })

  context("when using sidebar shortcuts in Zen", () => {
    it("leaves Zen and shows the requested panel", () => {
      const app = openKeys()
      app.keydown({ key: "z" })
      expect(app.shell().zen).not.toBeNull()
      app.keydown({ key: "b" })
      expect(app.shell().zen).toBeNull()
      app.keydown({ key: "z" })
      app.keydown({ key: "@", code: "Digit2", ctrlKey: true, shiftKey: true })
      expect(app.shell().zen).toBeNull()
      expect(app.ui.getSnapshot().location.route.panel).toBe("sessions")
    })
  })

  context("when a chord that acts once repeats", () => {
    it("swallows the repeat", () => {
      const app = openKeys()
      const newTerminal = { key: "T", ctrlKey: true, shiftKey: true }
      app.keydown(newTerminal)
      expect(app.keydown({ ...newTerminal, repeat: true })).toBe("handled")
      expect(app.state().roster.terminals).toHaveLength(3)
    })
  })
})

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
import { appearance, workspaceFixture, workspaceWithWindow } from "../../test/fixtures"
import type { Dictation } from "../../voice/dictation-control"
import { createKeyCommands, keyState, runKey } from "./keys"

type Press = Partial<Omit<KeyInput, "target">> & { target?: Partial<KeyTarget> }

const nowhere: KeyTarget = {
  editing: false,
  textEntry: false,
  modal: false,
  terminalInput: false,
  rename: false,
  viewSwitch: false,
  navigationControl: false,
  canvasNode: false,
  terminalTab: false,
  switcherClose: false,
  zenDock: false,
  companion: false,
  chat: false,
}

// The app's key handling on other platforms, over real stores and commands.
const openKeys = (options?: CommandsOptions & { dictation?: Dictation }) => {
  const app = openCommands(options)
  const withVoice = { ...app.context, dictation: options?.dictation }
  const keys = createKeyCommands(app.commands, withVoice)
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
      altGraph: false,
      defaultPrevented: false,
      ...press,
      target: { ...nowhere, ...target },
    }
    const environment = { overlayOpen: () => false, tabInteraction: () => false }
    const candidates = routeKey(
      bindings,
      phase,
      input,
      keyState(withVoice, app.commands),
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

// A 100px tile at a place on screen.
const tile = (id: string, left: number, top: number) => ({
  id,
  rect: { left, top, width: 100, height: 100 },
})

// The same, after Shift+Esc: navigating the workspace.
const navigating = (options?: CommandsOptions) => {
  const app = openKeys(options)
  app.commands.setNavigate(true)
  return app
}

afterEach(() => void vi.useRealTimers())

describe("key commands", () => {
  context("when pressing Escape", () => {
    it("returns Canvas to its origin before going back into the terminal, but not on repeat", () => {
      let returns = 0
      const canvas: CanvasHandle = { returnToOrigin: () => (returns++, true) }
      const app = navigating({
        workspace: workspaceFixture({ view: "canvas" }),
        url: "/projects/project/sessions/initial/canvas?terminal=01",
        canvas,
      })
      expect(app.keydown({ key: "Escape" })).toBe("handled")
      expect(returns).toBe(1)
      expect(app.shell().navigate).toBe(true)
      expect(app.keydown({ key: "Escape", repeat: true })).toBe("handled")
      expect(returns).toBe(1)
      expect(app.state().selected).toBe("01")
    })

    it("goes back into the selected terminal, then lets Escape through", () => {
      const app = navigating({
        workspace: workspaceFixture({ view: "focus" }),
        url: "/projects/project/sessions/initial/focus?terminal=02",
      })
      expect(app.keydown({ key: "Escape" })).toBe("handled")
      expect(app.shell()).toMatchObject({
        navigate: false,
        keyboardFocus: { id: "02", view: "focus" },
      })
      expect(app.state().selected).toBe("02")
      expect(app.keydown({ key: "Escape" })).toBe("passed")
    })

    it("navigates with Shift, moving keyboard focus to the view", () => {
      const app = openKeys()
      const shiftEscape = {
        key: "Escape",
        shiftKey: true,
        target: { editing: true, terminalInput: true },
      }
      expect(app.keydown(shiftEscape)).toBe("handled")
      expect(app.shell().navigate).toBe(true)
      expect(app.effects.at(-1)).toBe("focus viewport")
    })
  })

  context("when pressing Shift+Esc with no terminals", () => {
    it("lets it through without navigating, since there is no view", () => {
      const app = openKeys({ workspace: workspaceFixture({ terminals: 0 }) })
      expect(app.keydown({ key: "Escape", shiftKey: true })).toBe("passed")
      expect(app.shell().navigate).toBe(false)
    })
  })

  context("when pressing Enter while navigating on an undocked window", () => {
    it("keeps navigating, since a window takes no typing", () => {
      const app = navigating({
        workspace: workspaceWithWindow(),
        url: "/projects/project/sessions/initial/grid?terminal=w1",
      })
      expect(app.keydown({ key: "Enter" })).toBe("passed")
      expect(app.shell().navigate).toBe(true)
    })
  })

  context("when pressing Enter while navigating", () => {
    it("goes back into the terminal Focus shows, selecting it", () => {
      const app = navigating({
        workspace: workspaceFixture({ view: "focus" }),
        url: "/projects/project/sessions/initial/focus?terminal=",
      })
      expect(app.keydown({ key: "Enter" })).toBe("handled")
      expect(app.state().selected).toBe("01")
      expect(app.shell()).toMatchObject({ navigate: false, keyboardFocus: { id: "01" } })
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
      const app = navigating({ workspace: workspaceFixture({ terminals: 3 }) })
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
      const app = navigating({
        workspace: workspaceFixture({ view: "canvas" }),
        url: "/projects/project/sessions/initial/canvas?terminal=01",
      })
      app.keydown({ key: "ArrowDown", target: { canvasNode: true } })
      expect(app.shell().canvasKeyboardFocus).toMatchObject({ id: "02" })
    })

    it("steps through undocked windows as through terminals", () => {
      const app = navigating({
        workspace: workspaceWithWindow(),
        url: "/projects/project/sessions/initial/grid?terminal=02",
      })
      app.keydown({ key: "ArrowDown" })
      expect(app.state().selected).toBe("w1")
      app.keydown({ key: "ArrowDown" })
      expect(app.state().selected).toBe("01")
    })

    it("keeps arrows even when there are no terminals", () => {
      const app = navigating({ workspace: workspaceFixture({ terminals: 0 }) })
      expect(app.keydown({ key: "ArrowDown" })).toBe("handled")
    })
  })

  context("when pressing Shift with Left and Right", () => {
    it("steps through the enabled views, wrapping and skipping disabled ones", () => {
      const app = navigating({
        preferences: {
          fontSize: 13,
          enabledViews: ["focus", "canvas"],
          appearance,
          notifyFinished: true,
          ligatures: false,
          chatView: false,
        },
        workspace: workspaceFixture({ view: "canvas" }),
        url: "/projects/project/sessions/initial/canvas?terminal=01",
      })
      app.keydown({ key: "ArrowRight", shiftKey: true })
      expect(app.state().view).toBe("focus")
      app.keydown({ key: "ArrowLeft", shiftKey: true })
      expect(app.state().view).toBe("canvas")
    })

    it("steps through views with plain Left and Right on the view switch", () => {
      const app = navigating({
        workspace: workspaceFixture({ view: "grid" }),
        url: "/projects/project/sessions/initial/grid?terminal=01",
      })
      app.keydown({ key: "ArrowRight", target: { viewSwitch: true, navigationControl: true } })
      expect(app.state().view).toBe("canvas")
      expect(app.state().selected).toBe("01")
    })
  })

  context("when pressing arrows in Grid or Canvas", () => {
    // Three tiles in a row and one under the first:
    //   01 02 03
    //   04
    const laidOut = (view: "grid" | "canvas") => {
      const app = navigating({
        workspace: workspaceFixture({ view, terminals: 4 }),
        url: `/projects/project/sessions/initial/${view}?terminal=01`,
      })
      app.screen.tiles = [
        tile("01", 0, 0),
        tile("02", 110, 0),
        tile("03", 220, 0),
        tile("04", 0, 110),
      ]
      return app
    }

    for (const view of ["grid", "canvas"] as const) {
      it(`moves to the nearest tile on that side in ${view}`, () => {
        const app = laidOut(view)
        app.keydown({ key: "ArrowRight" })
        expect(app.state().selected).toBe("02")
        app.keydown({ key: "ArrowRight" })
        expect(app.state().selected).toBe("03")
        app.keydown({ key: "ArrowLeft" })
        app.keydown({ key: "ArrowLeft" })
        app.keydown({ key: "ArrowDown" })
        expect(app.state().selected).toBe("04")
        app.keydown({ key: "ArrowUp" })
        expect(app.state().selected).toBe("01")
      })

      it(`stops at the edge in ${view}`, () => {
        const app = laidOut(view)
        expect(app.keydown({ key: "ArrowLeft" })).toBe("handled")
        expect(app.keydown({ key: "ArrowUp" })).toBe("handled")
        expect(app.state().selected).toBe("01")
      })
    }

    it("follows sidebar order from the sidebar's list, and leaves Left and Right to it", () => {
      const app = laidOut("grid")
      app.keydown({ key: "ArrowDown", target: { terminalTab: true } })
      expect(app.state().selected).toBe("02")
      expect(app.keydown({ key: "ArrowRight", target: { terminalTab: true } })).toBe("passed")
      expect(app.state().selected).toBe("02")
    })
  })

  context("when jumping with Ctrl+Shift and an arrow", () => {
    it("selects the tile on that side and keeps typing there", () => {
      const app = openKeys({
        workspace: workspaceFixture({ view: "grid", terminals: 2 }),
        url: "/projects/project/sessions/initial/grid?terminal=01",
      })
      app.screen.tiles = [tile("01", 0, 0), tile("02", 110, 0)]
      const jump = { ctrlKey: true, shiftKey: true, target: { editing: true, terminalInput: true } }
      expect(app.keydown({ key: "ArrowRight", ...jump })).toBe("handled")
      expect(app.state().selected).toBe("02")
      expect(app.shell().keyboardFocus).toEqual({ id: "02", view: "grid" })
    })

    it("passes over an undocked window, which takes no typing", () => {
      const app = openKeys({
        workspace: workspaceWithWindow(),
        url: "/projects/project/sessions/initial/grid?terminal=02",
      })
      app.screen.tiles = [tile("01", 0, 0), tile("02", 110, 0), tile("w1", 220, 0)]
      expect(app.keydown({ key: "ArrowRight", ctrlKey: true, shiftKey: true })).toBe("handled")
      expect(app.state().selected).toBe("02")
      expect(app.keydown({ key: "ArrowLeft", ctrlKey: true, shiftKey: true })).toBe("handled")
      expect(app.state().selected).toBe("01")
    })

    it("swallows the chord at the edge rather than send it to the terminal", () => {
      const app = openKeys({
        workspace: workspaceFixture({ view: "grid", terminals: 2 }),
        url: "/projects/project/sessions/initial/grid?terminal=01",
      })
      app.screen.tiles = [tile("01", 0, 0), tile("02", 110, 0)]
      expect(app.keydown({ key: "ArrowLeft", ctrlKey: true, shiftKey: true })).toBe("handled")
      expect(app.state().selected).toBe("01")
    })
  })

  context("when pressing arrows in Focus", () => {
    it("steps through sidebar order with every arrow, from the terminal Focus shows", () => {
      const app = navigating({
        workspace: workspaceFixture({ view: "focus", terminals: 3 }),
        url: "/projects/project/sessions/initial/focus?terminal=02",
      })
      app.keydown({ key: "ArrowRight" })
      expect(app.state().selected).toBe("03")
      app.keydown({ key: "ArrowLeft" })
      expect(app.state().selected).toBe("02")
      app.keydown({ key: "ArrowUp" })
      expect(app.state().selected).toBe("01")
      app.keydown({ key: "ArrowUp" })
      expect(app.state().selected).toBe("03")
    })

    it("starts from the terminal Focus shows when none is selected", () => {
      const app = navigating({
        workspace: workspaceFixture({ view: "focus", terminals: 3 }),
        url: "/projects/project/sessions/initial/focus?terminal=",
      })
      app.keydown({ key: "ArrowDown" })
      expect(app.state().selected).toBe("02")
    })
  })

  context("when toggling Focus", () => {
    it("lets the key through when the destination view is disabled", () => {
      const app = openKeys({
        preferences: {
          fontSize: 13,
          enabledViews: ["grid", "canvas"],
          appearance,
          notifyFinished: true,
          ligatures: false,
          chatView: false,
        },
      })
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
      const app = navigating({
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
      const zen = { key: "Z", ctrlKey: true, shiftKey: true }
      app.keydown(zen)
      expect(app.shell().zen).not.toBeNull()
      app.keydown({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true })
      expect(app.shell().zen).toBeNull()
      app.keydown(zen)
      app.keydown({ key: "@", code: "Digit2", ctrlKey: true, shiftKey: true })
      expect(app.shell().zen).toBeNull()
      expect(app.ui.getSnapshot().location.route.panel).toBe("sessions")
    })
  })

  context("when typing with focus outside a terminal", () => {
    it("moves focus into the selected terminal and lets the key through to it", () => {
      const app = openKeys({ url: "/projects/project/sessions/initial/grid?terminal=02" })
      expect(app.keydown({ key: "l" })).toBe("passed")
      expect(app.effects).toContain("focus input 02")
    })

    it("does nothing with no terminal selected", () => {
      const app = openKeys({ url: "/projects/project/sessions/initial/grid" })
      app.commands.setSelected("")
      expect(app.keydown({ key: "l" })).toBe("passed")
      expect(app.effects.filter((effect) => effect.startsWith("focus input"))).toEqual([])
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

// A dictation that records what it was asked, standing in for the microphone.
const fakeDictation = (): Dictation & { readonly calls: string[]; recordingNow: boolean } => {
  const dictation = {
    calls: [] as string[],
    recordingNow: false,
    recording: () => dictation.recordingNow,
    active: () => dictation.recordingNow,
    press: (target: { terminalId: string } | undefined, code: string) =>
      void dictation.calls.push(`press ${target?.terminalId ?? "none"} ${code}`),
    release: (code: string) => void dictation.calls.push(`release ${code}`),
    blur: () => void dictation.calls.push("blur"),
    cancel: () => void dictation.calls.push("cancel"),
    toggle: (target: { terminalId: string }) =>
      void dictation.calls.push(`toggle ${target.terminalId}`),
  }
  return dictation
}

describe("key commands for voice input", () => {
  const chord = { key: "M", code: "KeyM", ctrlKey: true, shiftKey: true }

  context("when the shortcut is pressed", () => {
    it("dictates into the selected terminal, from its input too", () => {
      const dictation = fakeDictation()
      const app = openKeys({ dictation })
      expect(app.keydown({ ...chord, target: { editing: true, terminalInput: true } })).toBe(
        "handled",
      )
      expect(dictation.calls).toEqual(["press 01 KeyM"])
    })

    it("offers no target when an undocked window is selected", () => {
      const dictation = fakeDictation()
      const app = openKeys({
        dictation,
        workspace: workspaceWithWindow(),
        url: "/projects/project/sessions/initial/grid?terminal=w1",
      })
      app.keydown(chord)
      expect(dictation.calls).toEqual(["press none KeyM"])
    })

    it("swallows the key's repeats", () => {
      const dictation = fakeDictation()
      const app = openKeys({ dictation })
      app.keydown(chord)
      expect(app.keydown({ ...chord, repeat: true })).toBe("handled")
      expect(dictation.calls).toEqual(["press 01 KeyM"])
    })

    it("still keeps the key from the terminal where voice input is absent", () => {
      const app = openKeys()
      expect(app.keydown({ ...chord, target: { editing: true, terminalInput: true } })).toBe(
        "handled",
      )
    })
  })

  context("while recording", () => {
    it("reports the main key's release by its code, and lets other keyup layers run", () => {
      const dictation = fakeDictation()
      dictation.recordingNow = true
      const app = openKeys({ dictation })
      app.keyup({ key: "Control", code: "ControlLeft" })
      app.keyup({ key: "m", code: "KeyM" })
      expect(dictation.calls).toEqual(["release ControlLeft", "release KeyM"])
    })

    it("reports the window losing focus", () => {
      const dictation = fakeDictation()
      dictation.recordingNow = true
      openKeys({ dictation }).blur()
      expect(dictation.calls).toEqual(["blur"])
    })

    it("cancels on Escape without leaving Escape for the terminal", () => {
      const dictation = fakeDictation()
      dictation.recordingNow = true
      const app = openKeys({ dictation })
      expect(app.keydown({ key: "Escape", target: { editing: true, terminalInput: true } })).toBe(
        "handled",
      )
      expect(dictation.calls).toEqual(["cancel"])
    })
  })

  context("while not recording", () => {
    it("leaves releases, blur and Escape alone", () => {
      const dictation = fakeDictation()
      const app = openKeys({ dictation })
      app.keyup({ key: "m", code: "KeyM" })
      app.blur()
      expect(app.keydown({ key: "Escape", target: { editing: true, terminalInput: true } })).toBe(
        "passed",
      )
      expect(dictation.calls).toEqual([])
    })
  })
})

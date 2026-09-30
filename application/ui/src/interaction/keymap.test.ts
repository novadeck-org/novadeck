import { context, describe, expect, it } from "../test"
import type { KeyTarget } from "./dom"
import {
  keymapFor,
  routeKey,
  shortcutGroups,
  type KeyEnvironment,
  type KeyInput,
  type KeyPhase,
  type KeyState,
} from "./keymap"
import type { Platform } from "./shortcuts"

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
const terminalInput: Partial<KeyTarget> = { editing: true, terminalInput: true }

type Press = Partial<Omit<KeyInput, "target">> & { target?: Partial<KeyTarget> }
type Situation = { state?: Partial<KeyState>; environment?: Partial<KeyEnvironment> }

// The commands a key reaches, in the order they would be tried.
const route = (
  platform: Platform,
  phase: KeyPhase,
  { target, ...press }: Press,
  { state, environment }: Situation = {},
): string[] =>
  routeKey(
    keymapFor(platform),
    phase,
    {
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
    },
    { dialog: false, alert: false, switcher: null, held: false, ...state },
    { overlayOpen: () => false, tabInteraction: () => false, ...environment },
  ).map((binding) =>
    binding.args === undefined ? binding.command : `${binding.command} ${binding.args}`,
  )

// The platform's command modifier: ⌘ on Mac, Ctrl+Shift elsewhere.
const command = (platform: Platform): Press =>
  platform === "mac" ? { metaKey: true } : { ctrlKey: true, shiftKey: true }

const keydown = (platform: Platform, press: Press, situation?: Situation): string[] => [
  ...route(platform, "capture", press, situation),
  ...route(platform, "bubble", press, situation),
]

const platforms: Platform[] = ["mac", "other"]

// Preferences rows as "label: keys", under each group title.
const rows = (platform: Platform) =>
  shortcutGroups(platform).map(({ title, items }) => [
    title,
    ...items.map(({ label, display }) => `${label}: ${display.join(" ")}`),
  ])

describe("keymap", () => {
  for (const platform of platforms) {
    context(`on ${platform === "mac" ? "a Mac" : "other platforms"}`, () => {
      const find = { ...command(platform), key: platform === "mac" ? "k" : "K" }

      context("when cycling recent terminals with a held Control key", () => {
        it("starts or continues the switcher with Ctrl+Tab, even on a Mac", () => {
          expect(keydown(platform, { key: "Tab", ctrlKey: true })).toEqual(["recent.next"])
          expect(keydown(platform, { key: "Tab", ctrlKey: true, shiftKey: true })).toEqual([
            "recent.previous",
          ])
          expect(keydown(platform, { key: "Tab", metaKey: true })).toEqual([])
          expect(keydown(platform, { key: "Tab", ctrlKey: true, repeat: true })).toEqual([
            "recent.next",
          ])
        })

        it("moves with Up and Down even while Control or Shift is held, and ignores Left and Right", () => {
          const open = { state: { switcher: "held" as const, held: true } }
          expect(route(platform, "capture", { key: "ArrowUp", ctrlKey: true }, open)).toEqual([
            "switcher.move -1",
          ])
          expect(route(platform, "capture", { key: "ArrowDown", shiftKey: true }, open)).toEqual([
            "switcher.move 1",
          ])
          expect(route(platform, "capture", { key: "ArrowDown", altKey: true }, open)).toEqual([])
          expect(keydown(platform, { key: "ArrowLeft" }, open)).toEqual([])
          expect(keydown(platform, { key: "ArrowRight" }, open)).toEqual([])
        })

        it("commits on releasing Control and cancels when the window loses focus", () => {
          const held = { state: { switcher: "held" as const, held: true } }
          expect(route(platform, "keyup", { key: "Control" }, held)).toEqual(["recent.commitHeld"])
          expect(route(platform, "keyup", { key: "Shift" }, held)).toEqual([])
          expect(route(platform, "keyup", { key: "Control" })).toEqual([])
          expect(route(platform, "blur", {}, held)).toEqual(["recent.cancelHeld"])
          expect(route(platform, "blur", {})).toEqual([])
        })
      })

      context("when the switcher was opened with a click", () => {
        const clicked = { state: { switcher: "click" as const } }

        it("chooses with Enter and closes with Escape, whatever modifiers are held", () => {
          expect(keydown(platform, { key: "Enter", shiftKey: true }, clicked)).toEqual([
            "switcher.choose",
          ])
          expect(keydown(platform, { key: "Escape", altKey: true }, clicked)).toEqual([
            "switcher.close",
          ])
        })

        it("leaves Enter alone in a held switcher", () => {
          const held = { state: { switcher: "held" as const, held: true } }
          expect(keydown(platform, { key: "Enter" }, held)).toEqual([])
          expect(keydown(platform, { key: "Escape" }, held)).toEqual(["switcher.close"])
        })
      })

      context("when pressing Escape", () => {
        it("returns Canvas to its origin first, then clears the selection or sidebar", () => {
          expect(keydown(platform, { key: "Escape" })).toEqual([
            "canvas.returnToOrigin",
            "selection.clear",
          ])
        })

        it("leaves it to dialogs, the Zen dock, companion panes, overlays, editors and tab editing", () => {
          const cases: [Press, Situation][] = [
            [{ key: "Escape" }, { state: { dialog: true } }],
            [{ key: "Escape", target: { zenDock: true } }, {}],
            [{ key: "Escape", target: { companion: true } }, {}],
            [{ key: "Escape", target: { editing: true } }, {}],
            [{ key: "Escape", target: terminalInput }, {}],
            [{ key: "Escape" }, { environment: { overlayOpen: () => true } }],
            [{ key: "Escape" }, { environment: { tabInteraction: () => true } }],
            [{ key: "Escape", shiftKey: true }, {}],
          ]
          for (const [press, situation] of cases)
            expect(keydown(platform, press, situation)).toEqual([])
        })
      })

      context("when pressing arrows", () => {
        it("steps through terminals and views", () => {
          expect(route(platform, "capture", { key: "ArrowUp" })).toEqual(["terminal.step -1"])
          expect(route(platform, "capture", { key: "ArrowDown", repeat: true })).toEqual([
            "terminal.step 1",
          ])
          expect(route(platform, "capture", { key: "ArrowLeft" })).toEqual(["view.step -1"])
          expect(route(platform, "capture", { key: "ArrowRight" })).toEqual(["view.step 1"])
        })

        it("takes them over from the view switch but leaves other radio groups and the resizer", () => {
          expect(
            route(platform, "capture", {
              key: "ArrowRight",
              target: { viewSwitch: true, navigationControl: true },
            }),
          ).toEqual(["view.step 1"])
          expect(
            route(platform, "capture", { key: "ArrowRight", target: { navigationControl: true } }),
          ).toEqual([])
        })

        it("leaves them to inputs, companion panes, dialogs and modified presses", () => {
          expect(keydown(platform, { key: "ArrowDown", target: terminalInput })).toEqual([])
          expect(keydown(platform, { key: "ArrowDown", target: { companion: true } })).toEqual([])
          expect(keydown(platform, { key: "ArrowDown" }, { state: { dialog: true } })).toEqual([])
          expect(keydown(platform, { key: "ArrowDown", ctrlKey: true })).toEqual([])
          expect(keydown(platform, { key: "ArrowDown", shiftKey: true })).toEqual([])
        })
      })

      context("while an IME is composing", () => {
        it("routes nothing", () => {
          for (const press of [{ key: "Escape" }, { key: "ArrowDown" }, { key: "t" }, find])
            expect(keydown(platform, { ...press, composing: true })).toEqual([])
        })
      })

      context("when typing in an input", () => {
        it("keeps every key in a rename field", () => {
          const rename = { editing: true, rename: true }
          expect(keydown(platform, { ...find, target: rename })).toEqual([])
          expect(keydown(platform, { key: "Tab", ctrlKey: true, target: rename })).toEqual([])
        })

        it("keeps single keys in terminal input but runs modifier chords", () => {
          expect(keydown(platform, { key: "t", target: terminalInput })).toEqual([])
          expect(keydown(platform, { key: "Delete", target: terminalInput })).toEqual([])
          const newTerminal = { ...command(platform), key: platform === "mac" ? "t" : "T" }
          expect(keydown(platform, { ...newTerminal, target: terminalInput })).toEqual([
            "terminal.new",
          ])
          expect(
            keydown(platform, { ...command(platform), key: "Enter", target: terminalInput }),
          ).toEqual(["view.toggleFocus 1"])
        })
      })

      context("while an alert asks something", () => {
        it("runs no shortcut at all, not even Find, Preferences or a new terminal", () => {
          const alert = { state: { dialog: true, alert: true } }
          const preferences = { ctrlKey: platform !== "mac", metaKey: platform === "mac", key: "," }
          for (const press of [find, preferences, { ...command(platform), key: "t" }, { key: "t" }])
            expect(keydown(platform, press, alert)).toEqual([])
        })
      })

      context("while a dialog is open", () => {
        it("runs only Find and Preferences", () => {
          const dialog = { state: { dialog: true } }
          expect(keydown(platform, find, dialog)).toEqual(["search.open"])
          const preferences = { ctrlKey: platform !== "mac", metaKey: platform === "mac", key: "," }
          expect(keydown(platform, preferences, dialog)).toEqual(["preferences.open"])
          expect(keydown(platform, { ...command(platform), key: "t" }, dialog)).toEqual([])
          expect(keydown(platform, { key: "/" }, dialog)).toEqual([])
          expect(keydown(platform, { key: "z" }, dialog)).toEqual([])
        })
      })

      context("when matching chords", () => {
        it("uses Shift for new sessions and sidebars and matches sidebar digits by code", () => {
          const modifier = platform === "mac" ? { metaKey: true } : { ctrlKey: true }
          expect(keydown(platform, { ...modifier, shiftKey: true, key: "N" })).toEqual([
            "session.new",
          ])
          expect(
            keydown(platform, { ...modifier, shiftKey: true, key: "!", code: "Digit1" }),
          ).toEqual(["sidebar.terminals"])
          expect(
            keydown(platform, { ...modifier, shiftKey: true, key: "@", code: "Digit2" }),
          ).toEqual(["sidebar.sessions"])
        })

        it("requires exact modifiers and rejects Alt", () => {
          expect(keydown(platform, find)).toEqual(["search.open"])
          expect(keydown(platform, { ...find, altKey: true })).toEqual([])
          const other = platform === "mac" ? { ctrlKey: true, shiftKey: true } : { metaKey: true }
          expect(keydown(platform, { ...other, key: "k" })).toEqual([])
          expect(keydown(platform, { key: "/" })).toEqual(["search.open"])
          expect(keydown(platform, { key: "/", shiftKey: true })).toEqual([])
          expect(keydown(platform, { key: "Delete", shiftKey: true })).toEqual([])
        })
      })

      context("when pressing workspace keys", () => {
        it("routes each key and ignores repeats, overlays and an open switcher", () => {
          const keys = {
            "/": "search.open",
            f: "view.toggleFocus",
            t: "terminal.new",
            z: "zen.toggle",
          }
          for (const [key, id] of Object.entries(keys))
            expect(keydown(platform, { key })).toEqual([id])
          expect(keydown(platform, { key: "b" })).toEqual(["sidebar.terminals"])
          expect(keydown(platform, { key: "Delete" })).toEqual(["terminal.close"])
          expect(keydown(platform, { key: "F2" })).toEqual(["terminal.rename"])
          expect(keydown(platform, { key: "t", repeat: true })).toEqual([])
          expect(
            keydown(platform, { key: "t" }, { environment: { overlayOpen: () => true } }),
          ).toEqual([])
          expect(keydown(platform, { key: "t" }, { state: { switcher: "click" } })).toEqual([])
        })

        it("leaves Canvas zoom keys to Canvas", () => {
          for (const key of ["+", "-", "=", "0"]) expect(keydown(platform, { key })).toEqual([])
        })
      })

      context("when a chord repeats", () => {
        it("swallows the repeat for chords that act once", () => {
          const bindings = keymapFor(platform)
          const once = bindings
            .filter((binding) => binding.repeat === "swallow")
            .map((binding) => binding.command)
          expect(once).toEqual([
            "selection.clear",
            "session.new",
            "sidebar.terminals",
            "sidebar.sessions",
            "view.toggleFocus",
            "terminal.new",
          ])
        })
      })
    })
  }

  context("when listing shortcuts for Preferences", () => {
    it("shows the same rows as before, in the same order", () => {
      const workspace = [
        "Workspace",
        "Find a terminal: /",
        "Toggle Focus view: F",
        "New terminal: T",
        "Toggle Zen mode: Z",
        "Toggle terminal sidebar: B",
        "Rename active terminal: F2",
        "Previous / next terminal: ↑ ↓",
        "Previous / next view: ← →",
        "Deselect, then hide sidebar: Esc",
        "Zoom canvas in / out: + −",
        "Fit canvas to all terminals: 0",
      ]
      expect(rows("other")).toEqual([
        workspace,
        [
          "Anywhere",
          "Find a terminal: Ctrl Shift K",
          "Recent terminals: Ctrl Tab",
          "Previous recent terminal: Ctrl Shift Tab",
          "Toggle Focus view: Ctrl Shift Enter",
          "New terminal: Ctrl Shift T",
          "New session: Ctrl Shift N",
          "Toggle terminal sidebar: Ctrl Shift 1",
          "Toggle session sidebar: Ctrl Shift 2",
          "Open preferences: Ctrl ,",
        ],
      ])
      expect(rows("mac")).toEqual([
        workspace,
        [
          "Anywhere",
          "Find a terminal: ⌘ K",
          "Recent terminals: Ctrl Tab",
          "Previous recent terminal: Ctrl Shift Tab",
          "Toggle Focus view: ⌘ Enter",
          "New terminal: ⌘ T",
          "New session: ⌘ Shift N",
          "Toggle terminal sidebar: ⌘ Shift 1",
          "Toggle session sidebar: ⌘ Shift 2",
          "Open preferences: ⌘ ,",
        ],
      ])
      expect(shortcutGroups("mac").map(({ description }) => description)).toEqual([
        "When you’re not typing in a terminal, field, or dialog.",
        "These also work while typing in a terminal.",
      ])
    })
  })
})

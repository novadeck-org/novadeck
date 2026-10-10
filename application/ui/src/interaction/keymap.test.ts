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
const terminalInput: Partial<KeyTarget> = { editing: true, textEntry: true, terminalInput: true }

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
      altGraph: false,
      defaultPrevented: false,
      ...press,
      target: { ...nowhere, ...target },
    },
    {
      dialog: false,
      alert: false,
      switcher: null,
      held: false,
      navigate: false,
      dictating: false,
      ...state,
    },
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

// After Shift+Esc, while the person navigates the workspace.
const navigating: Situation = { state: { navigate: true } }

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

      context("when dictating by holding Ctrl+Shift+M", () => {
        const chord = { key: "M", ctrlKey: true, shiftKey: true, code: "KeyM" }
        const recording = { state: { dictating: true } }

        it("starts from a terminal's input, before the terminal can read it as Enter", () => {
          expect(route(platform, "capture", { ...chord, target: terminalInput })).toEqual([
            "voice.press",
          ])
        })

        it("starts from the workspace, but not from a text field or a dialog", () => {
          expect(route(platform, "capture", chord)).toEqual(["voice.press"])
          expect(route(platform, "capture", { ...chord, target: { editing: true } })).toEqual([])
          expect(route(platform, "capture", chord, { state: { dialog: true } })).toEqual([])
        })

        it("swallows the key's repeats instead of running them", () => {
          const [binding] = routeKey(
            keymapFor(platform),
            "capture",
            {
              ...chord,
              repeat: true,
              composing: false,
              altGraph: false,
              defaultPrevented: false,
              altKey: false,
              metaKey: false,
              target: nowhere,
            },
            {
              dialog: false,
              alert: false,
              switcher: null,
              held: false,
              navigate: false,
              dictating: true,
            },
            { overlayOpen: () => false, tabInteraction: () => false },
          )
          expect(binding).toMatchObject({ command: "voice.press", repeat: "swallow" })
        })

        it("ignores the chord with other modifiers", () => {
          expect(route(platform, "capture", { ...chord, altKey: true })).toEqual([])
          expect(route(platform, "capture", { ...chord, shiftKey: false })).toEqual([])
        })

        it("watches every key up while recording, so the main key can be found by its code", () => {
          expect(route(platform, "keyup", { key: "m", code: "KeyM" }, recording)).toEqual([
            "voice.release",
          ])
          expect(
            route(platform, "keyup", { key: "Control", code: "ControlLeft" }, recording),
          ).toEqual(["voice.release"])
          expect(route(platform, "keyup", { key: "m", code: "KeyM" })).toEqual([])
        })

        it("watches keys up beside a held switcher's release", () => {
          const both = { state: { dictating: true, switcher: "held" as const, held: true } }
          expect(route(platform, "keyup", { key: "Control", code: "ControlLeft" }, both)).toEqual([
            "voice.release",
            "recent.commitHeld",
          ])
        })

        it("ends a hold when the window loses focus", () => {
          expect(route(platform, "blur", {}, recording)).toEqual(["voice.blur"])
          expect(route(platform, "blur", {})).toEqual([])
        })

        it("cancels on Escape, whatever the target, ahead of everything else", () => {
          expect(keydown(platform, { key: "Escape" }, recording)).toEqual([
            "voice.cancel",
            "canvas.returnToOrigin",
            "navigate.exit",
          ])
          expect(
            route(
              platform,
              "capture",
              { key: "Escape", ctrlKey: true, target: terminalInput },
              recording,
            ),
          ).toEqual(["voice.cancel"])
          expect(route(platform, "capture", { key: "Escape" })).toEqual([
            "canvas.returnToOrigin",
            "navigate.exit",
          ])
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
        it("returns Canvas to its origin first, then goes back into the terminal", () => {
          expect(keydown(platform, { key: "Escape" }, navigating)).toEqual([
            "canvas.returnToOrigin",
            "navigate.exit",
          ])
        })

        it("enters navigating with Shift, from terminal input too but not from fields", () => {
          expect(keydown(platform, { key: "Escape", shiftKey: true })).toEqual(["navigate.enter"])
          expect(
            route(platform, "capture", { key: "Escape", shiftKey: true, target: terminalInput }),
          ).toEqual(["navigate.enter"])
          expect(
            keydown(platform, { key: "Escape", shiftKey: true, target: { editing: true } }),
          ).toEqual([])
          expect(
            keydown(platform, { key: "Escape", shiftKey: true }, { state: { dialog: true } }),
          ).toEqual([])
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
          ]
          for (const [press, situation] of cases)
            expect(
              keydown(platform, press, {
                ...situation,
                state: { navigate: true, ...situation.state },
              }),
            ).toEqual([])
        })
      })

      context("when pressing arrows", () => {
        it("steps between terminals in each direction, and between views with Shift, while navigating", () => {
          const step = (press: Press) => route(platform, "capture", press, navigating)
          expect(step({ key: "ArrowUp" })).toEqual(["terminal.step 0"])
          expect(step({ key: "ArrowRight" })).toEqual(["terminal.step 1"])
          expect(step({ key: "ArrowDown", repeat: true })).toEqual(["terminal.step 2"])
          expect(step({ key: "ArrowLeft" })).toEqual(["terminal.step 3"])
          expect(step({ key: "ArrowLeft", shiftKey: true })).toEqual(["view.step -1"])
          expect(step({ key: "ArrowRight", shiftKey: true })).toEqual(["view.step 1"])
          expect(step({ key: "ArrowDown", shiftKey: true })).toEqual([])
        })

        it("leaves them alone on the stage when not navigating, but not in the sidebar's list", () => {
          expect(keydown(platform, { key: "ArrowUp" })).toEqual([])
          expect(keydown(platform, { key: "ArrowRight", shiftKey: true })).toEqual([])
          expect(
            route(platform, "capture", { key: "ArrowDown", target: { terminalTab: true } }),
          ).toEqual(["terminal.step 2"])
        })

        it("jumps with the chord from terminal input and the workspace, not from fields", () => {
          const jump =
            platform === "mac" ? { metaKey: true, altKey: true } : { ctrlKey: true, shiftKey: true }
          expect(route(platform, "capture", { key: "ArrowLeft", ...jump })).toEqual([
            "terminal.jump 3",
          ])
          expect(
            route(platform, "capture", { key: "ArrowUp", ...jump, target: terminalInput }),
          ).toEqual(["terminal.jump 0"])
          expect(
            route(platform, "capture", { key: "ArrowUp", ...jump, target: { editing: true } }),
          ).toEqual([])
          expect(
            route(platform, "capture", { key: "ArrowUp", ...jump }, { state: { dialog: true } }),
          ).toEqual([])
        })

        it("starts dictation from a chat's box, which its words fill", () => {
          const chat = { editing: true, terminalInput: true, chat: true }
          const voice = { key: "M", ctrlKey: true, shiftKey: true, code: "KeyM" }
          expect(route(platform, "capture", { ...voice, target: chat })).toEqual(["voice.press"])
        })

        it("leaves a chat's box its word selection, but Shift+Esc still leaves it", () => {
          const jump =
            platform === "mac" ? { metaKey: true, altKey: true } : { ctrlKey: true, shiftKey: true }
          const chat = { editing: true, terminalInput: true, chat: true }
          expect(route(platform, "capture", { key: "ArrowLeft", ...jump, target: chat })).toEqual(
            [],
          )
          expect(
            route(platform, "capture", { key: "Escape", shiftKey: true, target: chat }),
          ).toEqual(["navigate.enter"])
        })

        it("takes them over from the view switch but leaves other radio groups and the resizer", () => {
          expect(
            route(platform, "capture", {
              key: "ArrowRight",
              target: { viewSwitch: true, navigationControl: true },
            }),
          ).toEqual(["terminal.step 1"])
          expect(
            route(platform, "capture", { key: "ArrowRight", target: { navigationControl: true } }),
          ).toEqual([])
        })

        it("leaves them to a rename field in the sidebar's list", () => {
          const renaming = { terminalTab: true, editing: true, rename: true }
          for (const press of [{ key: "ArrowDown" }, { key: "ArrowLeft", shiftKey: true }])
            expect(keydown(platform, { ...press, target: renaming }, navigating)).toEqual([])
        })

        it("leaves them to inputs, companion panes, dialogs and modified presses", () => {
          const press = (key: Press, state = {}) =>
            keydown(platform, key, { state: { navigate: true, ...state } })
          expect(press({ key: "ArrowDown", target: terminalInput })).toEqual([])
          expect(press({ key: "ArrowDown", target: { companion: true } })).toEqual([])
          expect(press({ key: "ArrowDown" }, { dialog: true })).toEqual([])
          expect(press({ key: "ArrowDown", ctrlKey: true })).toEqual([])
          expect(press({ key: "ArrowLeft", shiftKey: true, altKey: true })).toEqual([])
          expect(press({ key: "ArrowLeft", shiftKey: true, metaKey: true })).toEqual([])
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
          const zen = { ...command(platform), shiftKey: true, key: "Z" }
          expect(keydown(platform, zen, dialog)).toEqual([])
        })
      })

      context("when matching chords", () => {
        it("uses Shift for new sessions, Zen and sidebars and matches sidebar digits by code", () => {
          const modifier = platform === "mac" ? { metaKey: true } : { ctrlKey: true }
          expect(keydown(platform, { ...modifier, shiftKey: true, key: "N" })).toEqual([
            "session.new",
          ])
          expect(keydown(platform, { ...modifier, shiftKey: true, key: "Z" })).toEqual([
            "zen.toggle",
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
          expect(keydown(platform, { key: "Delete", shiftKey: true })).toEqual([])
        })
      })

      context("when switching to a pinned project", () => {
        const digit = (n: number, extra: Press = {}): Press => ({
          ctrlKey: platform !== "mac",
          metaKey: platform === "mac",
          key: String(n),
          code: `Digit${n}`,
          ...extra,
        })

        it("routes each digit in capture, so a terminal's input can't take it first", () => {
          for (let n = 1; n <= 9; n++) {
            expect(route(platform, "capture", digit(n, { target: terminalInput }))).toEqual([
              `project.pinned ${n - 1}`,
            ])
            expect(route(platform, "bubble", digit(n))).toEqual([])
          }
        })

        it("matches by code on any layout and leaves the sidebar chords alone", () => {
          expect(keydown(platform, digit(1, { key: "&" }))).toEqual(["project.pinned 0"])
          expect(keydown(platform, digit(0))).toEqual([])
          const sidebar = digit(1, { shiftKey: true, key: "!" })
          expect(keydown(platform, sidebar)).toEqual(["sidebar.terminals"])
          expect(keydown(platform, digit(2, { shiftKey: true, key: "@" }))).toEqual([
            "sidebar.sessions",
          ])
          expect(keydown(platform, digit(3, { altKey: true }))).toEqual([])
          expect(keydown(platform, { key: "3", code: "Digit3" })).not.toContain("project.pinned 2")
        })

        it("leaves text fields, such as a tab's rename, their keys", () => {
          const rename = { editing: true, textEntry: true, rename: true }
          expect(route(platform, "capture", digit(2, { target: rename }))).toEqual([])
          expect(route(platform, "capture", digit(2, { target: { textEntry: true } }))).toEqual([])
          // A modal dialog keeps the workspace behind it as it is.
          expect(
            route(platform, "capture", digit(2, { target: { editing: true, modal: true } })),
          ).toEqual([])
          // A menu, popover or switcher is not text entry.
          expect(route(platform, "capture", digit(2, { target: { editing: true } }))).toEqual([
            "project.pinned 1",
          ])
          expect(route(platform, "capture", digit(2, { target: terminalInput }))).toEqual([
            "project.pinned 1",
          ])
        })

        it("waits while a dialog is open and swallows repeats", () => {
          expect(keydown(platform, digit(2), { state: { dialog: true } })).toEqual([])
          expect(
            keydown(platform, digit(2), {
              state: { alert: true, dialog: true },
            }),
          ).toEqual([])
          const binding = keymapFor(platform).find((each) => each.command === "project.pinned")
          expect(binding?.repeat).toBe("swallow")
        })
      })

      context("when pressing workspace keys", () => {
        it("routes each key while navigating and ignores repeats, overlays and an open switcher", () => {
          expect(keydown(platform, { key: "Delete" }, navigating)).toEqual(["terminal.close"])
          expect(keydown(platform, { key: "F2" }, navigating)).toEqual(["terminal.rename"])
          expect(keydown(platform, { key: "Enter" }, navigating)).toEqual(["navigate.exit"])
          expect(keydown(platform, { key: "F2", repeat: true }, navigating)).toEqual([])
          expect(
            keydown(
              platform,
              { key: "F2" },
              { ...navigating, environment: { overlayOpen: () => true } },
            ),
          ).toEqual([])
          expect(
            keydown(platform, { key: "F2" }, { state: { navigate: true, switcher: "click" } }),
          ).toEqual([])
        })

        it("routes none of them when not navigating", () => {
          for (const key of ["Delete", "F2", "Enter", "Escape"])
            expect(keydown(platform, { key })).toEqual(
              key === "Escape" ? ["canvas.returnToOrigin", "navigate.exit"] : [],
            )
        })

        // Typing meant for a terminal that isn't focused goes to it, never to a workspace action.
        it("routes typed characters only into the selected terminal", () => {
          for (const key of "abcdefghijklmnopqrstuvwxyz0123456789/?.,;'[]-=`ąé€") {
            expect(keydown(platform, { key })).toEqual(["terminal.type"])
            expect(keydown(platform, { key: key.toUpperCase(), shiftKey: true })).toEqual([
              "terminal.type",
            ])
          }
          // Option on a Mac and AltGr (Ctrl+Alt) on Windows type characters too.
          expect(keydown(platform, { key: "@", altKey: true })).toEqual(["terminal.type"])
          const altGraph = { ctrlKey: true, altKey: true, altGraph: true }
          expect(keydown(platform, { key: "ł", ...altGraph })).toEqual(["terminal.type"])
          expect(keydown(platform, { key: "l", ctrlKey: true, altKey: true })).toEqual([])
        })

        it("leaves Space, named keys and chords alone", () => {
          for (const key of [" ", "Enter", "Tab", "Backspace", "Dead", "Shift"])
            expect(keydown(platform, { key })).not.toContain("terminal.type")
          expect(keydown(platform, { key: "a", ctrlKey: true })).toEqual([])
          expect(keydown(platform, { key: "a", metaKey: true })).toEqual([])
        })

        it("leaves typing to inputs, dialogs, overlays and the switcher", () => {
          expect(keydown(platform, { key: "a", target: terminalInput })).toEqual([])
          expect(keydown(platform, { key: "a", target: { editing: true } })).toEqual([])
          expect(keydown(platform, { key: "a" }, { state: { dialog: true } })).toEqual([])
          expect(
            keydown(platform, { key: "a" }, { environment: { overlayOpen: () => true } }),
          ).toEqual([])
          expect(keydown(platform, { key: "a" }, { state: { switcher: "click" } })).toEqual([])
        })

        // Canvas zooms on its own element and prevents the key before routing sees it.
        it("leaves Canvas zoom keys to Canvas", () => {
          for (const key of ["+", "-", "=", "0"])
            expect(keydown(platform, { key, defaultPrevented: true })).toEqual([])
        })
      })

      context("when a chord repeats", () => {
        it("swallows the repeat for chords that act once", () => {
          const bindings = keymapFor(platform)
          const once = bindings
            .filter((binding) => binding.repeat === "swallow")
            .map((binding) => binding.command)
          expect(once).toEqual([
            "voice.cancel",
            "navigate.exit",
            "voice.press",
            ...Array<string>(9).fill("project.pinned"),
            "session.new",
            "sidebar.terminals",
            "sidebar.sessions",
            "view.toggleFocus",
            "terminal.new",
            "zen.toggle",
          ])
        })
      })
    })
  }

  context("when listing shortcuts for Preferences", () => {
    it("lists the bare keys under Navigating and every chord under Anywhere", () => {
      const workspace = [
        "Navigating",
        "Terminal in that direction: ↑ ↓ ← →",
        "Previous / next view: Shift ← →",
        "Back into the terminal: Enter Esc",
        "Rename active terminal: F2",
        "Close active terminal: Delete",
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
          "Toggle Zen mode: Ctrl Shift Z",
          "New terminal: Ctrl Shift T",
          "New session: Ctrl Shift N",
          "Toggle terminal sidebar: Ctrl Shift 1",
          "Toggle session sidebar: Ctrl Shift 2",
          "Open preferences: Ctrl ,",
          "Navigate the workspace: Shift Esc",
          "Hold to dictate: Ctrl Shift M",
          "Terminal in that direction: Ctrl Shift ↑ ↓ ← →",
          "Switch to pinned project: Ctrl 1–9",
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
          "Toggle Zen mode: ⌘ Shift Z",
          "New terminal: ⌘ T",
          "New session: ⌘ Shift N",
          "Toggle terminal sidebar: ⌘ Shift 1",
          "Toggle session sidebar: ⌘ Shift 2",
          "Open preferences: ⌘ ,",
          "Navigate the workspace: Shift Esc",
          "Hold to dictate: Ctrl Shift M",
          "Terminal in that direction: ⌘ ⌥ ↑ ↓ ← →",
          "Switch to pinned project: ⌘ 1–9",
        ],
      ])
      expect(shortcutGroups("mac").map(({ description }) => description)).toEqual([
        "After Shift+Esc, until you type, press Enter or Esc, or click.",
        "These also work while typing in a terminal.",
      ])
    })
  })
})

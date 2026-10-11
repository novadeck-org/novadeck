import type { KeyTarget } from "./dom"
import {
  jumpShortcut,
  matchesShortcut,
  pinnedProjectShortcut,
  shortcutBindings,
  workspaceShortcutBindings,
  type Arrow,
  type Platform,
  type Shortcut,
} from "./shortcuts"

export type { Arrow, KeyTarget }

// Everything routing reads from a key event, so it can run without a DOM.
export type KeyInput = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "repeat"
> & {
  // An IME is composing text, which keeps every key.
  readonly composing: boolean
  // AltGr is held, which types characters, as Ctrl+Alt on Windows reports.
  readonly altGraph: boolean
  readonly defaultPrevented: boolean
  readonly target: KeyTarget
}

export type CommandId =
  | "search.open"
  | "preferences.open"
  | "session.new"
  | "sidebar.terminals"
  | "sidebar.sessions"
  | "recent.next"
  | "recent.previous"
  | "view.toggleFocus"
  | "terminal.new"
  | "terminal.type"
  | "zen.toggle"
  | "terminal.rename"
  | "terminal.close"
  | "canvas.returnToOrigin"
  | "navigate.enter"
  | "navigate.exit"
  | "switcher.close"
  | "switcher.choose"
  | "switcher.move"
  | "terminal.step"
  | "terminal.jump"
  | "project.pinned"
  | "view.step"
  | "recent.commitHeld"
  | "recent.cancelHeld"
  | "voice.press"
  | "voice.release"
  | "voice.blur"
  | "voice.cancel"

// Layers run in this order within their phase; each has one gate, below.
export type KeyLayer =
  | "dictation"
  | "switcher-nav"
  | "escape"
  | "navigation"
  | "jump"
  | "voice-chord"
  | "pinned-project"
  | "switcher"
  | "anywhere"
  | "app"
  | "navigate"
  | "workspace"
  | "release"
  | "voice"

export type KeyPhase = "capture" | "bubble" | "keyup" | "blur"

export type KeyPattern =
  | { readonly shortcut: Shortcut }
  // `none` requires no modifiers at all, `shift` exactly Shift; `any` ignores them.
  | { readonly key: string; readonly modifiers: "none" | "shift" | "any" }
  // A key that types a character, such as a letter, digit or punctuation, but not Space.
  | { readonly typed: true }
  // The window losing focus.
  | { readonly blur: true }
  // Any key, for the layers that watch a key's release by its `code`.
  | { readonly anyKey: true }

export type KeyBinding = {
  readonly layer: KeyLayer
  readonly keys: KeyPattern
  readonly command: CommandId
  readonly args?: number
  // A held key repeats: `run` runs every repeat, `swallow` prevents it without running.
  readonly repeat: "run" | "swallow"
  // Only while the switcher is open in click mode.
  readonly clickSwitcher?: true
}

export type KeyState = {
  // A dialog is open: a route dialog or an alert.
  readonly dialog: boolean
  // An alert dialog asks the person something, such as whether to close a terminal
  // or what to do about a crashing runner; even app-wide shortcuts wait for it.
  readonly alert: boolean
  // The switcher as it shows now, if it does.
  readonly switcher: "held" | "click" | null
  // A held switcher exists, even one that no longer shows.
  readonly held: boolean
  // The person is navigating the workspace, after Shift+Esc.
  readonly navigate: boolean
  // A voice clip is recording, held or hands-free, or its transcription is under way.
  readonly dictating: boolean
}

// DOM facts routing asks for only when a layer needs them.
export type KeyEnvironment = {
  readonly overlayOpen: () => boolean
  readonly tabInteraction: () => boolean
}

const phaseLayers: Record<KeyPhase, readonly KeyLayer[]> = {
  // Jumps run in capture, before a terminal's input takes its modified arrows.
  // Escape drops a recording before anything else can take it.
  capture: [
    "dictation",
    "switcher-nav",
    "escape",
    "navigation",
    "jump",
    "voice-chord",
    "pinned-project",
  ],
  bubble: ["switcher", "anywhere", "app", "navigate", "workspace"],
  keyup: ["voice", "release"],
  blur: ["voice", "release"],
}

const modified = (input: KeyInput): boolean =>
  input.ctrlKey || input.metaKey || input.altKey || input.shiftKey

// One character without Ctrl or ⌘; Option and AltGr, which Windows reports as Ctrl+Alt,
// may type one. Space stays with the button it would press.
const typed = (input: KeyInput): boolean =>
  [...input.key].length === 1 &&
  input.key !== " " &&
  !input.metaKey &&
  (!input.ctrlKey || input.altGraph)

const matches = (pattern: KeyPattern, input: KeyInput, phase: KeyPhase): boolean => {
  if ("blur" in pattern) return phase === "blur"
  if (phase === "blur") return false
  if ("anyKey" in pattern) return true
  if ("shortcut" in pattern) return matchesShortcut(input, pattern.shortcut)
  if ("typed" in pattern) return typed(input)
  if (input.key !== pattern.key) return false
  if (pattern.modifiers === "shift")
    return input.shiftKey && !input.ctrlKey && !input.metaKey && !input.altKey
  return pattern.modifiers === "any" || !modified(input)
}

const gates: Record<
  KeyLayer,
  (input: KeyInput, state: KeyState, environment: KeyEnvironment) => boolean
> = {
  dictation: (_input, state) => state.dictating,
  // Up and Down move through an open switcher, even with Control or Shift held.
  "switcher-nav": (input, state) => Boolean(state.switcher) && !input.altKey && !input.metaKey,
  // Escape belongs to whatever is open or being edited before the workspace.
  escape: (input, state, environment) =>
    !modified(input) &&
    !state.dialog &&
    !state.switcher &&
    !input.target.editing &&
    !input.target.zenDock &&
    !input.target.notice &&
    !input.target.companion &&
    !environment.overlayOpen() &&
    !environment.tabInteraction(),
  // While navigating, arrows move between terminals and Shift+arrows between views, except
  // where a control or a companion pane (which scrolls, and moves through its own buttons)
  // uses them itself. Otherwise only the sidebar's list and the view switch take them.
  navigation: (input, state) =>
    !input.ctrlKey &&
    !input.metaKey &&
    !input.altKey &&
    !state.dialog &&
    !state.switcher &&
    (input.target.viewSwitch ||
      (input.target.terminalTab && !input.target.editing) ||
      (state.navigate &&
        !input.target.editing &&
        !input.target.navigationControl &&
        !input.target.companion)),
  // From terminal input or the workspace; text fields and editors keep them to select,
  // and so does a chat's box, which is a text field of its own: only Shift+Esc leaves it.
  jump: (input, state) =>
    !state.dialog &&
    !state.switcher &&
    (!input.target.editing ||
      (input.target.terminalInput && !(input.target.chat && input.key !== "Escape"))),
  // Dictation's chord works where the jumps do, and in a chat's box too, which it fills.
  "voice-chord": (input, state) =>
    !state.dialog && !state.switcher && (!input.target.editing || input.target.terminalInput),
  // Ctrl+Shift or ⌘ and a digit, which a terminal would read as its own input, so it runs in
  // capture; with no such pin the command lets the key on. It leaves text fields, a tab's
  // rename among them, their keys, and a modal dialog its question, but works from menus,
  // popovers and the switchers.
  "pinned-project": (input, state) =>
    !state.dialog && !input.target.modal && (!input.target.textEntry || input.target.terminalInput),
  switcher: (_input, state) => Boolean(state.switcher),
  anywhere: (_input, state) => !state.alert,
  app: (_input, state) => !state.dialog,
  // Unmodified keys act on the workspace only while navigating it.
  navigate: (input, state, environment) =>
    state.navigate &&
    !input.repeat &&
    !state.dialog &&
    !state.switcher &&
    !input.target.editing &&
    !environment.overlayOpen(),
  // Typing anywhere but a terminal, field or dialog.
  workspace: (input, state, environment) =>
    !input.repeat &&
    !state.dialog &&
    !state.switcher &&
    !input.target.editing &&
    !environment.overlayOpen(),
  release: (_input, state) => state.held,
  voice: (_input, state) => state.dictating,
}

// The bindings that may handle this event, in the order to try them. The caller runs
// each until one handles it or reports itself unavailable.
export const routeKey = (
  bindings: readonly KeyBinding[],
  phase: KeyPhase,
  input: KeyInput,
  state: KeyState,
  environment: KeyEnvironment,
): readonly KeyBinding[] => {
  const keydown = phase === "capture" || phase === "bubble"
  if (keydown && (input.defaultPrevented || input.composing)) return []
  // A rename field keeps every key that reaches it.
  if (phase === "bubble" && input.target.rename) return []
  return phaseLayers[phase].flatMap((layer) => {
    const candidates = bindings.filter(
      (binding) =>
        binding.layer === layer &&
        matches(binding.keys, input, phase) &&
        (!binding.clickSwitcher || state.switcher === "click"),
    )
    return candidates.length && gates[layer](input, state, environment) ? candidates : []
  })
}

// Arrow commands carry their direction as an index into this list.
export const arrowDirections: readonly Arrow[] = ["up", "right", "down", "left"]

const key = (value: string, modifiers: "none" | "shift" | "any" = "none"): KeyPattern => ({
  key: value,
  modifiers,
})

export const keymapFor = (platform: Platform): readonly KeyBinding[] => {
  const chord = shortcutBindings(platform)
  const single = workspaceShortcutBindings()
  return [
    {
      layer: "switcher-nav",
      keys: key("ArrowUp", "any"),
      command: "switcher.move",
      args: -1,
      repeat: "run",
    },
    {
      layer: "switcher-nav",
      keys: key("ArrowDown", "any"),
      command: "switcher.move",
      args: 1,
      repeat: "run",
    },
    { layer: "dictation", keys: key("Escape", "any"), command: "voice.cancel", repeat: "swallow" },
    // Canvas returns to its origin first; otherwise Escape goes back into the terminal.
    { layer: "escape", keys: key("Escape"), command: "canvas.returnToOrigin", repeat: "run" },
    { layer: "escape", keys: key("Escape"), command: "navigate.exit", repeat: "swallow" },
    // Arrows move to the terminal on that side in Grid and Canvas, and through sidebar
    // order in Focus and the sidebar's list; Shift+Left and Right change the view.
    ...(["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"] as const).map(
      (arrow, args): KeyBinding => ({
        layer: "navigation",
        keys: key(arrow),
        command: "terminal.step",
        args,
        repeat: "run",
      }),
    ),
    {
      layer: "navigation",
      keys: key("ArrowLeft", "shift"),
      command: "view.step",
      args: -1,
      repeat: "run",
    },
    {
      layer: "navigation",
      keys: key("ArrowRight", "shift"),
      command: "view.step",
      args: 1,
      repeat: "run",
    },
    // Shift+Esc, from a terminal too: the one way into navigating.
    { layer: "jump", keys: { shortcut: chord.navigate }, command: "navigate.enter", repeat: "run" },
    // Dictation starts in capture, so a terminal's input can't take the chord first.
    {
      layer: "voice-chord",
      keys: { shortcut: chord.voice },
      command: "voice.press",
      repeat: "swallow",
    },
    ...arrowDirections.map((arrow, args): KeyBinding => ({
      layer: "jump",
      keys: { shortcut: jumpShortcut(arrow, platform) },
      command: "terminal.jump",
      args,
      repeat: "run",
    })),
    // Ctrl+Shift+1 to 9 (⌘1 to 9 on Apple platforms): the Nth pinned project, from terminal
    // input too.
    ...Array.from({ length: 9 }, (_, args): KeyBinding => ({
      layer: "pinned-project",
      keys: { shortcut: pinnedProjectShortcut(args, platform) },
      command: "project.pinned",
      args,
      repeat: "swallow",
    })),
    {
      layer: "switcher",
      keys: key("Escape", "any"),
      command: "switcher.close",
      repeat: "run",
    },
    {
      layer: "switcher",
      keys: key("Enter", "any"),
      command: "switcher.choose",
      repeat: "run",
      clickSwitcher: true,
    },
    { layer: "anywhere", keys: { shortcut: chord.find }, command: "search.open", repeat: "run" },
    {
      layer: "anywhere",
      keys: { shortcut: chord.preferences },
      command: "preferences.open",
      repeat: "run",
    },
    {
      layer: "app",
      keys: { shortcut: chord.newSession },
      command: "session.new",
      repeat: "swallow",
    },
    {
      layer: "app",
      keys: { shortcut: chord.terminals },
      command: "sidebar.terminals",
      repeat: "swallow",
    },
    {
      layer: "app",
      keys: { shortcut: chord.sessions },
      command: "sidebar.sessions",
      repeat: "swallow",
    },
    { layer: "app", keys: { shortcut: chord.recent }, command: "recent.next", repeat: "run" },
    { layer: "app", keys: { shortcut: chord.previous }, command: "recent.previous", repeat: "run" },
    // From terminal input the chord keeps typing focus in the terminal (args 1).
    {
      layer: "app",
      keys: { shortcut: chord.focus },
      command: "view.toggleFocus",
      args: 1,
      repeat: "swallow",
    },
    {
      layer: "app",
      keys: { shortcut: chord.newTerminal },
      command: "terminal.new",
      repeat: "swallow",
    },
    { layer: "app", keys: { shortcut: chord.zen }, command: "zen.toggle", repeat: "swallow" },
    { layer: "navigate", keys: key("Enter"), command: "navigate.exit", repeat: "run" },
    { layer: "navigate", keys: key("Delete"), command: "terminal.close", repeat: "run" },
    {
      layer: "navigate",
      keys: { shortcut: single.rename },
      command: "terminal.rename",
      repeat: "run",
    },
    // Typing outside a terminal goes into the selected one.
    { layer: "workspace", keys: { typed: true }, command: "terminal.type", repeat: "run" },
    // The hold ends with its own key, found by `code`, since modifiers may come up first.
    { layer: "voice", keys: { anyKey: true }, command: "voice.release", repeat: "run" },
    { layer: "voice", keys: { blur: true }, command: "voice.blur", repeat: "run" },
    { layer: "release", keys: key("Control", "any"), command: "recent.commitHeld", repeat: "run" },
    { layer: "release", keys: { blur: true }, command: "recent.cancelHeld", repeat: "run" },
  ]
}

export type ShortcutGroup = {
  readonly title: string
  readonly description: string
  readonly items: readonly { readonly label: string; readonly display: readonly string[] }[]
}

// The shortcut table Preferences shows. Canvas zoom keys stay in Canvas's own handler
// and appear here only as rows.
export const shortcutGroups = (platform: Platform): readonly ShortcutGroup[] => [
  {
    title: "Navigating",
    description: "After Shift+Esc, until you type, press Enter or Esc, or click.",
    items: [
      { label: "Terminal in that direction", display: ["↑", "↓", "←", "→"] },
      { label: "Previous / next view", display: ["Shift", "←", "→"] },
      { label: "Back into the terminal", display: ["Enter", "Esc"] },
      ...Object.values(workspaceShortcutBindings()),
      { label: "Close active terminal", display: ["Delete"] },
      { label: "Zoom canvas in / out", display: ["+", "−"] },
      { label: "Fit canvas to all terminals", display: ["0"] },
    ],
  },
  {
    title: "Anywhere",
    description: "These also work while typing in a terminal.",
    items: [
      ...Object.values(shortcutBindings(platform)),
      {
        label: jumpShortcut("up", platform).label,
        display: [...jumpShortcut("up", platform).display.slice(0, -1), "↑", "↓", "←", "→"],
      },
      {
        label: pinnedProjectShortcut(0, platform).label,
        display: platform === "mac" ? ["⌘", "1–9"] : ["Ctrl", "Shift", "1–9"],
      },
    ],
  },
]

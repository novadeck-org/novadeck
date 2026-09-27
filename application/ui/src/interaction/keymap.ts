import type { KeyTarget } from "./dom"
import {
  matchesShortcut,
  shortcutBindings,
  workspaceShortcutBindings,
  type Platform,
  type Shortcut,
} from "./shortcuts"

export type { KeyTarget }

// Everything routing reads from a key event, so it can run without a DOM.
export type KeyInput = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "repeat"
> & {
  // An IME is composing text, which keeps every key.
  readonly composing: boolean
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
  | "zen.toggle"
  | "terminal.rename"
  | "terminal.close"
  | "canvas.returnToOrigin"
  | "selection.clear"
  | "switcher.close"
  | "switcher.choose"
  | "switcher.move"
  | "terminal.step"
  | "view.step"
  | "recent.commitHeld"
  | "recent.cancelHeld"

// Layers run in this order within their phase; each has one gate, below.
export type KeyLayer =
  | "switcher-nav"
  | "escape"
  | "navigation"
  | "switcher"
  | "anywhere"
  | "app"
  | "workspace"
  | "release"

export type KeyPhase = "capture" | "bubble" | "keyup" | "blur"

export type KeyPattern =
  | { readonly shortcut: Shortcut }
  // `none` requires no modifiers at all; `any` ignores them.
  | { readonly key: string; readonly modifiers: "none" | "any" }
  // The window losing focus.
  | { readonly blur: true }

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
  readonly dialog: boolean
  // The switcher as it shows now, if it does.
  readonly switcher: "held" | "click" | null
  // A held switcher exists, even one that no longer shows.
  readonly held: boolean
}

// DOM facts routing asks for only when a layer needs them.
export type KeyEnvironment = {
  readonly overlayOpen: () => boolean
  readonly tabInteraction: () => boolean
}

const phaseLayers: Record<KeyPhase, readonly KeyLayer[]> = {
  capture: ["switcher-nav", "escape", "navigation"],
  bubble: ["switcher", "anywhere", "app", "workspace"],
  keyup: ["release"],
  blur: ["release"],
}

const modified = (input: KeyInput): boolean =>
  input.ctrlKey || input.metaKey || input.altKey || input.shiftKey

const matches = (pattern: KeyPattern, input: KeyInput, phase: KeyPhase): boolean => {
  if ("blur" in pattern) return phase === "blur"
  if (phase === "blur") return false
  if ("shortcut" in pattern) return matchesShortcut(input, pattern.shortcut)
  return input.key === pattern.key && (pattern.modifiers === "any" || !modified(input))
}

const gates: Record<
  KeyLayer,
  (input: KeyInput, state: KeyState, environment: KeyEnvironment) => boolean
> = {
  // Up and Down move through an open switcher, even with Control or Shift held.
  "switcher-nav": (input, state) => Boolean(state.switcher) && !input.altKey && !input.metaKey,
  // Escape belongs to whatever is open or being edited before the workspace.
  escape: (input, state, environment) =>
    !modified(input) &&
    !state.dialog &&
    !state.switcher &&
    !input.target.editing &&
    !input.target.zenDock &&
    !environment.overlayOpen() &&
    !environment.tabInteraction(),
  // Arrows move through terminals and views, except where a control uses them itself.
  navigation: (input, state) =>
    !modified(input) &&
    !state.dialog &&
    !state.switcher &&
    (input.target.viewSwitch || (!input.target.editing && !input.target.navigationControl)),
  switcher: (_input, state) => Boolean(state.switcher),
  anywhere: () => true,
  app: (_input, state) => !state.dialog,
  // Single keys work only while navigating the workspace itself.
  workspace: (input, state, environment) =>
    !input.repeat &&
    !state.dialog &&
    !state.switcher &&
    !input.target.editing &&
    !environment.overlayOpen(),
  release: (_input, state) => state.held,
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

const key = (value: string, modifiers: "none" | "any" = "none"): KeyPattern => ({
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
    // Canvas returns to its origin first; otherwise Escape clears the selection, then the sidebar.
    { layer: "escape", keys: key("Escape"), command: "canvas.returnToOrigin", repeat: "run" },
    { layer: "escape", keys: key("Escape"), command: "selection.clear", repeat: "swallow" },
    {
      layer: "navigation",
      keys: key("ArrowUp"),
      command: "terminal.step",
      args: -1,
      repeat: "run",
    },
    {
      layer: "navigation",
      keys: key("ArrowDown"),
      command: "terminal.step",
      args: 1,
      repeat: "run",
    },
    { layer: "navigation", keys: key("ArrowLeft"), command: "view.step", args: -1, repeat: "run" },
    { layer: "navigation", keys: key("ArrowRight"), command: "view.step", args: 1, repeat: "run" },
    { layer: "switcher", keys: key("Escape", "any"), command: "switcher.close", repeat: "run" },
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
    { layer: "workspace", keys: { shortcut: single.find }, command: "search.open", repeat: "run" },
    {
      layer: "workspace",
      keys: { shortcut: single.focus },
      command: "view.toggleFocus",
      repeat: "run",
    },
    {
      layer: "workspace",
      keys: { shortcut: single.newTerminal },
      command: "terminal.new",
      repeat: "run",
    },
    { layer: "workspace", keys: { shortcut: single.zen }, command: "zen.toggle", repeat: "run" },
    {
      layer: "workspace",
      keys: { shortcut: single.terminals },
      command: "sidebar.terminals",
      repeat: "run",
    },
    { layer: "workspace", keys: key("Delete"), command: "terminal.close", repeat: "run" },
    {
      layer: "workspace",
      keys: { shortcut: single.rename },
      command: "terminal.rename",
      repeat: "run",
    },
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
// and appear here only as rows; Delete works but is not listed.
export const shortcutGroups = (platform: Platform): readonly ShortcutGroup[] => [
  {
    title: "Workspace",
    description:
      "When navigating the workspace, outside text inputs, editors, and dialogs. Works with Zen on or off.",
    items: [
      ...Object.values(workspaceShortcutBindings()),
      { label: "Previous / next terminal", display: ["↑", "↓"] },
      { label: "Previous / next view", display: ["←", "→"] },
      { label: "Deselect, then hide sidebar", display: ["Esc"] },
      { label: "Zoom in / out · Canvas background", display: ["+", "−"] },
      { label: "Fit all · Canvas background", display: ["0"] },
    ],
  },
  {
    title: "Anywhere",
    description:
      "Modifier shortcuts also work from terminal input. Editors and dialogs keep their own controls.",
    items: Object.values(shortcutBindings(platform)),
  },
]

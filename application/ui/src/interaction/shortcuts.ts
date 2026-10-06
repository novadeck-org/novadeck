export type Shortcut = {
  label: string
  key: string
  code?: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  // Option or Alt; left out, it must not be held.
  alt?: boolean
  display: string[]
}

export type Platform = "mac" | "other"

// Apple platforms use ⌘ where others use Ctrl+Shift.
export const currentPlatform = (): Platform =>
  /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other"

export type ShortcutName =
  | "find"
  | "recent"
  | "previous"
  | "focus"
  | "zen"
  | "newTerminal"
  | "newSession"
  | "terminals"
  | "sessions"
  | "preferences"
  | "navigate"
  | "voice"

// Modifier shortcuts, which also work from terminal input.
export const shortcutBindings = (
  platform: Platform = currentPlatform(),
): Record<ShortcutName, Shortcut> => {
  const mac = platform === "mac"
  return {
    find: {
      label: "Find a terminal",
      key: "k",
      ctrl: !mac,
      meta: mac,
      shift: !mac,
      display: mac ? ["⌘", "K"] : ["Ctrl", "Shift", "K"],
    },
    recent: {
      label: "Recent terminals",
      key: "Tab",
      ctrl: true,
      meta: false,
      shift: false,
      display: ["Ctrl", "Tab"],
    },
    previous: {
      label: "Previous recent terminal",
      key: "Tab",
      ctrl: true,
      meta: false,
      shift: true,
      display: ["Ctrl", "Shift", "Tab"],
    },
    focus: {
      label: "Toggle Focus view",
      key: "Enter",
      ctrl: !mac,
      meta: mac,
      shift: !mac,
      display: mac ? ["⌘", "Enter"] : ["Ctrl", "Shift", "Enter"],
    },
    zen: {
      label: "Toggle Zen mode",
      key: "z",
      ctrl: !mac,
      meta: mac,
      shift: true,
      display: [mac ? "⌘" : "Ctrl", "Shift", "Z"],
    },
    newTerminal: {
      label: "New terminal",
      key: "t",
      ctrl: !mac,
      meta: mac,
      shift: !mac,
      display: mac ? ["⌘", "T"] : ["Ctrl", "Shift", "T"],
    },
    newSession: {
      label: "New session",
      key: "n",
      ctrl: !mac,
      meta: mac,
      shift: true,
      display: [mac ? "⌘" : "Ctrl", "Shift", "N"],
    },
    terminals: {
      label: "Toggle terminal sidebar",
      key: "1",
      code: "Digit1",
      ctrl: !mac,
      meta: mac,
      shift: true,
      display: [mac ? "⌘" : "Ctrl", "Shift", "1"],
    },
    sessions: {
      label: "Toggle session sidebar",
      key: "2",
      code: "Digit2",
      ctrl: !mac,
      meta: mac,
      shift: true,
      display: [mac ? "⌘" : "Ctrl", "Shift", "2"],
    },
    preferences: {
      label: "Open preferences",
      key: ",",
      ctrl: !mac,
      meta: mac,
      shift: false,
      display: [mac ? "⌘" : "Ctrl", ","],
    },
    navigate: {
      label: "Navigate the workspace",
      key: "Escape",
      ctrl: false,
      meta: false,
      shift: true,
      display: ["Shift", "Esc"],
    },
    // Held while speaking, so it must come up as a key of its own: macOS reports no keyup
    // for a letter while ⌘ is down, which rules out ⌘ there, and the same Ctrl+Shift chord
    // serves every platform. Ctrl+Space and ⌘Space belong to the input method or Spotlight,
    // a bare modifier can't be told from the start of another chord, and Alt or Option
    // letters type characters in shells and on Apple keyboards. M for microphone is free in
    // the app and in the agent CLIs; the keymap handles it before a terminal can read it as
    // Ctrl+M, an Enter.
    voice: {
      label: "Hold to dictate",
      key: "m",
      ctrl: true,
      meta: false,
      shift: true,
      display: ["Ctrl", "Shift", "M"],
    },
  }
}

export type Arrow = "up" | "right" | "down" | "left"

const arrowKeys: Record<Arrow, { key: string; display: string }> = {
  up: { key: "ArrowUp", display: "↑" },
  right: { key: "ArrowRight", display: "→" },
  down: { key: "ArrowDown", display: "↓" },
  left: { key: "ArrowLeft", display: "←" },
}

// Moves to the terminal on that side and keeps typing there, from terminal input too:
// ⌘⌥ and an arrow on Apple platforms, Ctrl+Shift and an arrow elsewhere.
export const jumpShortcut = (arrow: Arrow, platform: Platform = currentPlatform()): Shortcut => {
  const mac = platform === "mac"
  const { key, display } = arrowKeys[arrow]
  return {
    label: "Terminal in that direction",
    key,
    ctrl: !mac,
    meta: mac,
    shift: !mac,
    alt: mac,
    display: mac ? ["⌘", "⌥", display] : ["Ctrl", "Shift", display],
  }
}

export type WorkspaceShortcutName = "rename"

// Keys that work only while navigating the workspace. None is a letter or other printable
// key, so typing meant for a terminal never triggers one.
export const workspaceShortcutBindings = (): Record<WorkspaceShortcutName, Shortcut> => ({
  rename: {
    label: "Rename active terminal",
    key: "F2",
    ctrl: false,
    meta: false,
    shift: false,
    display: ["F2"],
  },
})

export { workspaceShortcutTarget, workspaceOverlayOpen } from "./dom"

export type ShortcutInput = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
>

// Exact modifiers.
export const matchesShortcut = (event: ShortcutInput, shortcut: Shortcut): boolean =>
  (event.key.toLowerCase() === shortcut.key.toLowerCase() ||
    (shortcut.code !== undefined && event.code === shortcut.code)) &&
  event.ctrlKey === shortcut.ctrl &&
  event.metaKey === shortcut.meta &&
  event.shiftKey === shortcut.shift &&
  event.altKey === Boolean(shortcut.alt)

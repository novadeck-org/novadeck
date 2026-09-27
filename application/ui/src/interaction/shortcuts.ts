export type Shortcut = {
  label: string
  key: string
  code?: string
  ctrl: boolean
  meta: boolean
  shift: boolean
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
  | "newTerminal"
  | "newSession"
  | "terminals"
  | "sessions"
  | "preferences"

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
  }
}

export type WorkspaceShortcutName =
  | "find"
  | "focus"
  | "newTerminal"
  | "zen"
  | "terminals"
  | "rename"

// Single keys, which work only while navigating the workspace itself.
export const workspaceShortcutBindings = (): Record<WorkspaceShortcutName, Shortcut> => ({
  find: {
    label: "Find a terminal",
    key: "/",
    ctrl: false,
    meta: false,
    shift: false,
    display: ["/"],
  },
  focus: {
    label: "Toggle Focus view",
    key: "f",
    ctrl: false,
    meta: false,
    shift: false,
    display: ["F"],
  },
  newTerminal: {
    label: "New terminal",
    key: "t",
    ctrl: false,
    meta: false,
    shift: false,
    display: ["T"],
  },
  zen: {
    label: "Toggle Zen mode",
    key: "z",
    ctrl: false,
    meta: false,
    shift: false,
    display: ["Z"],
  },
  terminals: {
    label: "Toggle terminal sidebar",
    key: "b",
    ctrl: false,
    meta: false,
    shift: false,
    display: ["B"],
  },
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

// Exact modifiers; Alt never matches.
export const matchesShortcut = (event: ShortcutInput, shortcut: Shortcut): boolean =>
  (event.key.toLowerCase() === shortcut.key.toLowerCase() ||
    (shortcut.code !== undefined && event.code === shortcut.code)) &&
  event.ctrlKey === shortcut.ctrl &&
  event.metaKey === shortcut.meta &&
  event.shiftKey === shortcut.shift &&
  !event.altKey

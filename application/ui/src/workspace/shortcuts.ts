export type Shortcut = {
  label: string
  key: string
  code?: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  display: string[]
}

export const shortcutBindings = (): Record<
  | "find"
  | "recent"
  | "previous"
  | "focus"
  | "newTerminal"
  | "newSession"
  | "terminals"
  | "sessions"
  | "preferences",
  Shortcut
> => {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
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

export const workspaceShortcutBindings = (): Record<
  "find" | "focus" | "newTerminal" | "zen" | "terminals" | "rename",
  Shortcut
> => ({
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

// Choice inputs such as the view switcher's radios are navigation, not text entry.
const editingOrOverlay =
  'input:not([type="radio"], [type="checkbox"], [type="button"], [type="submit"], [type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, [role="textbox"], [role="searchbox"], [role="combobox"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="slider"], [role="spinbutton"], [role="tablist"], [data-scope="popover"][data-state="open"]'

export const workspaceShortcutTarget = (target: EventTarget | null): boolean =>
  !(target instanceof Element && target.closest(editingOrOverlay))

export const workspaceOverlayOpen = (): boolean =>
  Boolean(
    document.querySelector(
      '[role="dialog"]:not([aria-hidden="true"]), [role="menu"]:not([hidden]), [role="listbox"][data-state="open"], [data-scope="popover"][data-state="open"]',
    ),
  )

export const matchesShortcut = (event: KeyboardEvent, shortcut: Shortcut): boolean =>
  (event.key.toLowerCase() === shortcut.key.toLowerCase() ||
    (shortcut.code !== undefined && event.code === shortcut.code)) &&
  event.ctrlKey === shortcut.ctrl &&
  event.metaKey === shortcut.meta &&
  event.shiftKey === shortcut.shift &&
  !event.altKey

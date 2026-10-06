// DOM contracts for keyboard policy and focus restoration. Library-specific
// overlay markup stays here so interaction owners do not depend on it. `data-own-keys`
// marks a region that takes its own keys, as the demo's debug panel does: the
// workspace's shortcuts, Escape among them, leave keys there alone, and a click there
// keeps focus where it landed.
const editingOrOverlay =
  'input:not([type="radio"], [type="checkbox"], [type="button"], [type="submit"], [type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"]), .xterm, [role="textbox"], [role="searchbox"], [role="combobox"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="slider"], [role="spinbutton"], [role="tablist"], [data-scope="popover"][data-state="open"], [data-own-keys]'

export const workspaceShortcutTarget = (target: EventTarget | null): boolean =>
  !(target instanceof Element && target.closest(editingOrOverlay))

export const workspaceOverlayOpen = (): boolean =>
  Boolean(
    document.querySelector(
      '[role="dialog"]:not([aria-hidden="true"]), [role="alertdialog"]:not([aria-hidden="true"]), [role="menu"]:not([hidden]), [role="listbox"][data-state="open"], [data-scope="popover"][data-state="open"]',
    ),
  )

const within = (target: EventTarget | null, selector: string): boolean =>
  target instanceof Element && Boolean(target.closest(selector))
export const insideOpenZenDock = (target: EventTarget | null): boolean =>
  within(target, '[data-workspace-zen-dock][data-open="true"]')
export const insideViewSwitch = (target: EventTarget | null): boolean =>
  within(target, "[data-workspace-view-switch]")
export const insideNavigationControl = (target: EventTarget | null): boolean =>
  within(target, '[role="separator"], [role="radiogroup"]')
export const insideCanvasNode = (target: EventTarget | null): boolean =>
  within(target, "[data-workspace-canvas-node], .react-flow__node")
export const insideTerminalTab = (target: EventTarget | null): boolean =>
  within(target, "[data-terminal-tab-id]")
export const insideTerminalRename = (target: EventTarget | null): boolean =>
  within(target, 'input[aria-label^="Rename "]')
export const insideSwitcherClose = (target: EventTarget | null): boolean =>
  within(target, '[aria-label="Close terminal switcher"]')
// Where keys move around the workspace while navigating: a view itself, or a Canvas node.
export const navigateHome = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.matches("[data-workspace-viewport], [data-workspace-canvas-node], .react-flow__node")
// A region that takes its own keys and clicks (see `editingOrOverlay`).
export const insideOwnKeys = (target: EventTarget | null): boolean =>
  within(target, "[data-own-keys]")
// A terminal's companion pane and its taskbar close themselves on Escape.
export const insideCompanion = (target: EventTarget | null): boolean =>
  within(target, "[data-workspace-companion]")
// Terminal surfaces mark the element that receives typed input.
export const insideTerminalInput = (target: EventTarget | null): boolean =>
  within(target, "[data-terminal-input]")
// Where a key was pressed, as far as keyboard routing cares.
export type KeyTarget = {
  // Text fields, editors, and open menus or dialogs keep their own keys.
  readonly editing: boolean
  readonly terminalInput: boolean
  readonly rename: boolean
  readonly viewSwitch: boolean
  // The sidebar resizer and radio groups use arrows themselves.
  readonly navigationControl: boolean
  readonly canvasNode: boolean
  readonly terminalTab: boolean
  readonly switcherClose: boolean
  readonly zenDock: boolean
  readonly companion: boolean
}

export const classifyKeyTarget = (target: EventTarget | null): KeyTarget => ({
  editing: !workspaceShortcutTarget(target),
  terminalInput: insideTerminalInput(target),
  rename: insideTerminalRename(target),
  viewSwitch: insideViewSwitch(target),
  navigationControl: insideNavigationControl(target),
  canvasNode: insideCanvasNode(target),
  terminalTab: insideTerminalTab(target),
  switcherClose: insideSwitcherClose(target),
  zenDock: insideOpenZenDock(target),
  companion: insideCompanion(target),
})

export const terminalTabInteractionActive = (): boolean =>
  Boolean(document.querySelector(".terminal-tab.editing, .terminal-tab.dragging"))

export const sidebarToggle = (panel: "terminals" | "sessions"): HTMLElement | null =>
  document.getElementById(`${panel}-toggle`)
export const focusSidebarToggle = (panel: "terminals" | "sessions"): void =>
  sidebarToggle(panel)?.focus()
export const focusTerminalTab = (id: string): void =>
  document
    .querySelector<HTMLElement>(`[data-terminal-tab-id="${CSS.escape(id)}"] .sidebar-item-select`)
    ?.focus({ preventScroll: true })
export const focusWorkspaceViewport = (): void =>
  document.querySelector<HTMLElement>("[data-workspace-viewport]")?.focus({ preventScroll: true })
export const focusZenCreate = (): void =>
  document.querySelector<HTMLElement>("[data-workspace-zen-create]")?.focus({ preventScroll: true })
export const focusZenEnter = (): void =>
  document.querySelector<HTMLElement>("[data-workspace-zen-enter]")?.focus({ preventScroll: true })

export const focusTerminalInput = (id: string): boolean => {
  const input = terminalElement(id)?.querySelector<HTMLElement>("[data-terminal-input]")
  input?.focus({ preventScroll: true })
  return Boolean(input) && document.activeElement === input
}

// Each shown tile's frame, once, leaving out tiles hidden while they animate away.
export const tileRects = (): { id: string; rect: DOMRect }[] => {
  const seen = new Set<string>()
  return [...(workspaceArea()?.querySelectorAll<HTMLElement>("[data-terminal]") ?? [])].flatMap(
    (element) => {
      const id = element.dataset.terminal
      if (!id || seen.has(id) || element.closest("[inert]")) return []
      seen.add(id)
      return [{ id, rect: element.getBoundingClientRect() }]
    },
  )
}

export const workspaceArea = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-workspace-area]")
export const terminalElement = (id: string): HTMLElement | null =>
  workspaceArea()?.querySelector<HTMLElement>(`[data-terminal="${CSS.escape(id)}"]`) ?? null
export const workspaceContent = (): HTMLElement | null =>
  workspaceArea()?.querySelector<HTMLElement>("[data-terminal], [data-workspace-empty]") ?? null
export const terminalSurface = (terminal: HTMLElement): HTMLElement | null =>
  terminal.querySelector<HTMLElement>("[data-terminal-content]")

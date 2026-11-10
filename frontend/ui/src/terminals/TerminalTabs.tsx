import {
  Accessibility,
  Cursor,
  Feedback,
  KeyboardSensor,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { DragDropProvider } from "@dnd-kit/react"
import { isSortable } from "@dnd-kit/react/sortable"
import type { Tile } from "@novadeck/core/types"
import { PullOut } from "@novadeck/toolkit/drag-pull"
import { sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import {
  Fragment,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { TabListContext } from "./tab-list"

const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
  }),
  KeyboardSensor.configure({
    keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ["Space"] },
  }),
]
// What a screen reader says of each tab: dnd-kit's description, by an id the tab names
// itself, so a tooltip on the tab can't take its place.
const reorderId = "terminal-tabs"
export const tabInstructionsId = `dnd-kit-description-${reorderId}`
const accessibility = Accessibility.configure({
  id: reorderId,
  screenReaderInstructions: {
    draggable:
      "Press Enter to select a terminal. Press Space to pick up a tab, use arrow keys to reorder, then Space to drop or Escape to cancel.",
  },
})
const feedback = Feedback.configure({
  dropAnimation: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
})
const cursor = Cursor.configure({ cursor: "pointer" })

// Where a tab pulled out of the list goes (`PullOut`: it stays in the list until the person
// pulls it free): told as a tab is picked up, how the pull stands, where the pointer is as it
// moves, and as it drops, which answers whether the drop was taken there, as a move to another
// session, so the list keeps its order. `bounds` is how far a free tab may travel, read as the
// drag starts.
export type TabsAway = {
  readonly bounds: () => Element | null
  readonly start: (terminalId: string) => void
  readonly pull: (pull: { readonly tension: number; readonly free: boolean }) => void
  readonly move: (point: { readonly x: number; readonly y: number }) => void
  readonly end: (terminalId: string, canceled: boolean) => boolean
}

// How hard a tab is to pull out of the list: stiffer than the toolkit's default, as reordering
// is what a tab's drag is mostly for. Grabbed at its middle, it gives as the pointer reaches the
// rail; grabbed nearer the rail, where there's less room, as it nears the window's edge.
const tabPull = { give: 10, breakAt: 140 }

const within = (box: DOMRect, { x, y }: { readonly x: number; readonly y: number }): boolean =>
  x >= box.left && x <= box.right && y >= box.top && y <= box.bottom

export const TerminalTabs = ({
  terminals,
  renderTab,
  onReorder,
  away,
}: {
  terminals: readonly Tile[]
  // Renders one sortable tab, usually a TerminalTab, at its position in the list.
  renderTab: (terminal: Tile, index: number) => ReactNode
  // Saves the order a drag ends on.
  onReorder: (ids: string[]) => void
  // Where a tab may be dragged beyond the list; without it, it stays in the list.
  away?: TabsAway | undefined
}): React.JSX.Element => {
  const [list, setList] = useState<HTMLDivElement | null>(null)
  // Bumped when a drag ends: the drag library moves a tab's element next to the one it passes,
  // into that tab's wrapper, which React's next update can't follow (a tab closed later would
  // leave its row behind, or take another's with it), so the tabs mount anew, in the saved
  // order if a drop saved another than the drag showed (a drag past a folded lead).
  // `focus` is the tab whose button held focus as the drag ended (a keyboard drag), which the
  // new tabs give it back to.
  const [drag, setDrag] = useState<{ generation: number; focus: string | null }>({
    generation: 0,
    focus: null,
  })
  // The list, for the drag bounds and for the workspace's store of the list on screen.
  const tabList = useContext(TabListContext)
  const attach = useCallback(
    (node: HTMLDivElement) => {
      setList(node)
      tabList?.update(() => node)
      return () => {
        setList(null)
        tabList?.update((current) => (current === node ? null : current))
      }
    },
    [tabList],
  )
  // After each remount (each drag is a new state), as one tab dragged twice running is focused
  // twice.
  useLayoutEffect(() => {
    const { focus } = drag
    if (focus === null) return
    const tab = [...(list?.querySelectorAll<HTMLElement>("[data-terminal-tab-id]") ?? [])].find(
      (each) => each.dataset.terminalTabId === focus,
    )
    tab?.querySelector<HTMLElement>("button")?.focus()
  }, [drag, list])
  const bounds = away?.bounds
  const pull = away?.pull
  const modifiers = useMemo(
    () => [
      bounds && pull
        ? PullOut.configure({ element: list, within: bounds, feel: tabPull, onPull: pull })
        : RestrictToElement.configure({ element: list }),
    ],
    [bounds, pull, list],
  )
  return (
    <DragDropProvider
      sensors={sensors}
      modifiers={modifiers}
      plugins={(defaults) => [...defaults, accessibility, feedback, cursor]}
      onDragStart={(event) => {
        const { source, activatorEvent } = event.operation
        // The keyboard reorders only; a tab goes elsewhere from its menu.
        if (isSortable(source) && !(activatorEvent instanceof KeyboardEvent))
          away?.start(String(source.id))
      }}
      onDragMove={(event) => away?.move(event.operation.position.current)}
      onDragEnd={(event) => {
        const { source } = event.operation
        if (!isSortable(source)) return
        const taken = away?.end(String(source.id), event.canceled) ?? false
        const held = document.activeElement
        const focused = held && list?.contains(held) ? held.closest("[data-terminal-tab-id]") : null
        setDrag((current) => ({
          generation: current.generation + 1,
          focus: focused?.getAttribute("data-terminal-tab-id") ?? null,
        }))
        if (taken || event.canceled || source.initialIndex === source.index) return
        // A tab pulled out and let go elsewhere goes back to its place, not to where it last
        // passed over the list.
        if (away && list && !within(list.getBoundingClientRect(), event.operation.position.current))
          return
        const order = terminals.map((terminal) => terminal.id)
        const from = order.indexOf(String(source.id))
        if (from < 0) return
        const [id] = order.splice(from, 1)
        order.splice(source.index, 0, id!)
        onReorder(order)
      }}
    >
      <div className={`terminal-tab-list ${sidebarListClasses}`} ref={attach}>
        <Fragment key={drag.generation}>
          {terminals.map((terminal, index) => renderTab(terminal, index))}
        </Fragment>
        {!terminals.length && (
          <p className="terminal-tab-empty px-3 py-3 text-control">No open sessions</p>
        )}
      </div>
    </DragDropProvider>
  )
}

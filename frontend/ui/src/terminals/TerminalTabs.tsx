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
import { sidebarListClasses } from "@novadeck/toolkit/SidebarItem"
import { Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

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

export const TerminalTabs = ({
  terminals,
  renderTab,
  onReorder,
}: {
  terminals: readonly Tile[]
  // Renders one sortable tab, usually a TerminalTab, at its position in the list.
  renderTab: (terminal: Tile, index: number) => ReactNode
  // Saves the order a drag ends on, and says the order it saved where it moved tabs the person
  // can't see (a folded lead's team, kept right after it).
  onReorder: (ids: string[]) => readonly string[] | void
}): React.JSX.Element => {
  const [list, setList] = useState<HTMLDivElement | null>(null)
  // Bumped when a drop saved another order than the drag showed: the drag library already moved
  // the tabs to its own, which React's next update can't follow, so the tabs mount anew in the
  // saved order. Only a drag past a folded lead does that.
  const [generation, setGeneration] = useState(0)
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
  const modifiers = useMemo(() => [RestrictToElement.configure({ element: list })], [list])
  return (
    <DragDropProvider
      sensors={sensors}
      modifiers={modifiers}
      plugins={(defaults) => [...defaults, accessibility, feedback, cursor]}
      onDragEnd={(event) => {
        if (event.canceled) return
        const { source } = event.operation
        if (!isSortable(source) || source.initialIndex === source.index) return
        const order = terminals.map((terminal) => terminal.id)
        const from = order.indexOf(String(source.id))
        if (from < 0) return
        const [id] = order.splice(from, 1)
        order.splice(source.index, 0, id!)
        const saved = onReorder(order)
        if (saved && saved.some((each, index) => each !== order[index]))
          setGeneration((current) => current + 1)
      }}
    >
      <div className={`terminal-tab-list ${sidebarListClasses}`} ref={attach}>
        <Fragment key={generation}>
          {terminals.map((terminal, index) => renderTab(terminal, index))}
        </Fragment>
        {!terminals.length && (
          <p className="terminal-tab-empty px-3 py-3 text-control">No open sessions</p>
        )}
      </div>
    </DragDropProvider>
  )
}

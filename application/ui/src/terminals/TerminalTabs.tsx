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
import { useMemo, useState, type ReactNode } from "react"

import type { Tile } from "../model/types"
import { sidebarListClasses } from "../sidebar/SidebarItem"

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
  onReorder: (ids: string[]) => void
}): React.JSX.Element => {
  const [list, setList] = useState<HTMLDivElement | null>(null)
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
        onReorder(order)
      }}
    >
      <div className={`terminal-tab-list ${sidebarListClasses}`} ref={setList}>
        {terminals.map((terminal, index) => renderTab(terminal, index))}
        {!terminals.length && (
          <p className="terminal-tab-empty px-3 py-3 text-[11px]">No open sessions</p>
        )}
      </div>
    </DragDropProvider>
  )
}

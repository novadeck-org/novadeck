import {
  Accessibility,
  Cursor,
  Feedback,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom"
import { RestrictToElement, RestrictToWindow } from "@dnd-kit/dom/modifiers"
import { DragDropProvider } from "@dnd-kit/react"
import { isSortable } from "@dnd-kit/react/sortable"
import { Fragment, useContext, useLayoutEffect, useMemo, useRef, useState } from "react"

import type { Project } from "../model/types"
import { PinDropContext } from "./pin-drop"
import { arrangeProjects, pinLimit, type ProjectArrangement } from "./project-arrangement"
import type { ProjectStatus } from "./project-status"
import { ProjectRow } from "./ProjectRow"

// A row follows the pointer once it has moved a few pixels, so a click still selects it;
// the keyboard moves rows with Alt and the arrows instead, so dnd-kit adds no keyboard
// sensor and none of its screen reader markup.
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
  }),
]
const feedback = Feedback.configure({
  dropAnimation: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
})
const cursor = Cursor.configure({ cursor: "grabbing" })
// How far past the menu a dragged row goes before it counts as out of it.
const leeway = 24

// The projects as the person arranged them: the pinned ones under a label, a rule, then
// the rest. Rows drag into any order within the list; the arrangement itself is the
// caller's, told by `onMove` (to a place in the list, pinned ones first) and `onStep`
// (one place, as Alt and the arrows move the focused row). Where a pins bar listens
// (`PinDropContext`), a row dragged out of the list is pinned there and then, and the bar
// drags its pin on (`onDraggedOut` closes the list). A row dragged past its sides never
// scrolls it sideways.
export const ProjectList = ({
  projects,
  current,
  statuses,
  arrangement,
  removable,
  onSelect,
  onMove,
  onStep,
  onTogglePin,
  onRemove,
  onDraggedOut,
}: {
  projects: Project[]
  // The id of the project the workspace shows.
  current: string
  // What each project's terminals show, by its id, where they show anything.
  statuses: Readonly<Record<string, ProjectStatus>>
  arrangement: ProjectArrangement
  removable: boolean
  onSelect: (id: string) => void
  onMove: (id: string, index: number) => void
  onStep: (id: string, by: -1 | 1) => void
  onTogglePin: (id: string) => void
  onRemove: (project: Project) => void
  // A row was dragged out of the list and its drag went to the pins bar: the caller closes
  // (unmounts) the list, whose row stays unseen till then; its own order stays as it was.
  onDraggedOut: () => void
}): React.JSX.Element => {
  // The projects as listed: the pinned ones, then the rest.
  const { pinned, rest } = arrangeProjects(projects, arrangement)
  const listed = [...pinned, ...rest]
  const pinAvailable = pinned.length < pinLimit
  // The element that holds the rows, which a drag stays within.
  const [list, setList] = useState<HTMLDivElement | null>(null)
  const pinDrop = useContext(PinDropContext)
  // The drag left the list and went to the pins bar.
  const handedOff = useRef(false)
  // The row whose drag went to the pins bar, unseen in the list as it closes.
  const [gone, setGone] = useState<string | null>(null)
  // Where the rows began on screen as the drag started, before they made room for it.
  const rowsTop = useRef<number | null>(null)
  // A row that can reach the pins bar leaves the list; otherwise it stays in it.
  const modifiers = useMemo(
    () =>
      pinDrop ? [RestrictToWindow.configure({})] : [RestrictToElement.configure({ element: list })],
    [list, pinDrop],
  )
  // The row that takes the focus, after a keyboard move or a drag; a new object asks again.
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null)
  // dnd-kit moves the dragged row's element among its neighbours as it goes, never the
  // label or the rule, and puts it back only in some drags; every drag's end remounts
  // the rows, so they are rebuilt from the arrangement. That drops the focus with the
  // dragged row, which is asked for again.
  const [dragged, setDragged] = useState(0)
  // Where the list was scrolled as the drag ended: the remount empties it for a moment,
  // which scrolls it back to the top, so it is put back before the next paint.
  const scrolledTo = useRef<{ readonly list: HTMLElement; readonly top: number } | null>(null)
  useLayoutEffect(() => {
    const at = scrolledTo.current
    if (at) at.list.scrollTop = at.top
    scrolledTo.current = null
  })
  return (
    <div
      className="workspace-switcher-projects flex max-h-[min(560px,calc(100vh-150px))] flex-col gap-1 overflow-x-hidden overflow-y-auto p-[5px]"
      aria-label="Workspaces"
      ref={setList}
    >
      <DragDropProvider
        key={dragged}
        sensors={sensors}
        modifiers={modifiers}
        plugins={(defaults) => [
          ...defaults.filter((plugin) => plugin !== Accessibility),
          feedback,
          cursor,
        ]}
        onDragStart={(event) => {
          const { source } = event.operation
          if (!source) return
          const id = String(source.id)
          handedOff.current = false
          setGone(null)
          rowsTop.current =
            list?.querySelector(".workspace-switcher-row")?.getBoundingClientRect().top ?? null
          pinDrop?.start(id, pinAvailable || pinned.some((project) => project.id === id))
        }}
        onDragMove={(event, manager) => {
          if (!pinDrop || handedOff.current) return
          const point = event.to ?? event.operation.position.current
          const menu = list?.parentElement?.getBoundingClientRect()
          if (!menu) return
          // Out once clearly past the menu: a little above its rows (the pinned label at
          // most, over the bar) or its top where they're scrolled away, or past its sides
          // or bottom, so a reorder that swings wide or flicks to the top stays one. Out,
          // the project is pinned and the bar drags its pin on; the list's drag ends.
          const away =
            point.y < Math.max(rowsTop.current ?? menu.top, menu.top) - 4 ||
            point.x < menu.left - leeway ||
            point.x > menu.right + leeway ||
            point.y > menu.bottom + leeway
          if (!away || !pinDrop.handOff(point)) return
          handedOff.current = true
          // The bar's pin takes over as what's dragged; the row's ghost goes at once, and the
          // row stays unseen in the list as it closes.
          const { source } = event.operation
          if (source) setGone(String(source.id))
          const row = source?.element
          if (row instanceof HTMLElement) row.style.visibility = "hidden"
          queueMicrotask(() => manager.actions.stop({ canceled: true }))
        }}
        onDragEnd={(event) => {
          if (list) scrolledTo.current = { list, top: list.scrollTop }
          setDragged((count) => count + 1)
          pinDrop?.end()
          if (handedOff.current) {
            handedOff.current = false
            onDraggedOut()
            return
          }
          const { source } = event.operation
          if (!isSortable(source)) return
          const id = String(source.id)
          setFocusRequest({ id })
          if (event.canceled || source.initialIndex === source.index) return
          onMove(id, source.index)
        }}
      >
        {pinned.length > 0 && (
          <div className="workspace-switcher-label section-label px-2.5 pt-1 pb-0.5 text-label font-medium">
            Pinned
          </div>
        )}
        {listed.map((project, index) => (
          <Fragment key={project.id}>
            {pinned.length > 0 && index === pinned.length && rest.length > 0 && (
              <hr className="workspace-switcher-rule" />
            )}
            <ProjectRow
              project={project}
              index={index}
              selected={project.id === current}
              status={statuses[project.id]}
              pinned={index < pinned.length}
              pinBlocked={!pinAvailable}
              away={project.id === gone}
              removable={removable}
              focusRequest={focusRequest}
              onFocused={() => setFocusRequest(null)}
              onSelect={() => onSelect(project.id)}
              onTogglePin={() => onTogglePin(project.id)}
              onStep={(by) => {
                setFocusRequest({ id: project.id })
                onStep(project.id, by)
              }}
              onRemove={() => onRemove(project)}
            />
          </Fragment>
        ))}
      </DragDropProvider>
    </div>
  )
}

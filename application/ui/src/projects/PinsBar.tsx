import {
  Accessibility,
  Cursor,
  Feedback,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { DragDropProvider } from "@dnd-kit/react"
import { isSortable, useSortable } from "@dnd-kit/react/sortable"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { pinnedProjectShortcut } from "../interaction/shortcuts"
import { Tooltip } from "../ui-toolkit/Tooltip"
import { pinsThatFit } from "./pins-fit"
import { needsPerson, statusText, type ProjectStatus } from "./project-status"

type Pin = { readonly id: string; readonly name: string; readonly directory: string }

// As in the switcher's list: a pin follows the pointer once it has moved a few pixels, so a
// click still switches to it, and the keyboard moves pins with Alt and the arrows, so
// dnd-kit adds no keyboard sensor and none of its screen reader markup.
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
  }),
]
// How long pins take to slide aside or settle, none for a person who asks for less motion.
const slide = (): number => (matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180)
const ease = "cubic-bezier(0.16, 1, 0.3, 1)"
const cursor = Cursor.configure({ cursor: "grabbing" })

// The pinned projects, as a bar under the header, in the person's order: each pin is its
// number (its Ctrl or ⌘ shortcut), its name and a mark of what its project's terminals ask
// of the person, and a click switches to it. The bar slides in with the first pin and out
// with the last. The current pin stays in its place, marked as current, so switching never
// moves the others, and a mark's slot is always there, so one appearing never does either.
// They take the room the bar leaves them: each shows whole or not at all, the last ones
// first to go, and `onShown` says which show. All stay in the bar so each can be measured;
// the ones that don't fit are hidden and inert.
// Pins drag along the bar into any order, and Alt with the left and right arrows moves the
// focused pin one place; `onMove` (to a place among the pins) and `onStep` tell the
// arrangement, which is the caller's. A pin never leaves the bar this way: it can't be
// dropped or stepped past the last pin.
export const PinsBar = ({
  pins,
  current,
  statuses,
  hidden = false,
  onSelect,
  onMove,
  onStep,
  onShown,
}: {
  pins: readonly Pin[]
  // The project the workspace shows.
  current: string
  // What each project's terminals show, by its id, where they show anything.
  statuses: Readonly<Record<string, ProjectStatus>>
  // Hidden with the header, in Zen.
  hidden?: boolean
  onSelect: (id: string) => void
  onMove: (id: string, index: number) => void
  onStep: (id: string, by: -1 | 1) => void
  onShown: (ids: readonly string[]) => void
}): React.JSX.Element => {
  // The last pins stay while the bar slides out.
  const [items, setItems] = useState(pins)
  if (pins.length > 0 && pins !== items) setItems(pins)
  const open = pins.length > 0 && !hidden

  // A page that loads with pins shows the bar as it is; only later changes slide.
  const [animated, setAnimated] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimated(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const row = useRef<HTMLDivElement | null>(null)
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null)
  const rowRef = useCallback((node: HTMLDivElement | null) => {
    row.current = node
    setRowElement(node)
  }, [])
  const feedback = useMemo(
    () => Feedback.configure({ dropAnimation: { duration: slide(), easing: ease } }),
    [],
  )
  const modifiers = useMemo(
    () => [RestrictToElement.configure({ element: rowElement })],
    [rowElement],
  )
  // The pin that takes the focus, after a keyboard move or a drag; a new object asks again.
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null)
  // dnd-kit moves the dragged pin's element among its neighbours as it goes and puts it
  // back only in some drags, so every drag's end remounts the pins from the order, and the
  // focus is asked for again.
  const [drags, setDrags] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [count, setCount] = useState(items.length)
  // As the bar slides out the pins stay as they were shown, so they slide away in view.
  const shown = Math.min(count, items.length)

  // Measures before paint, and again as the bar or a pin changes size.
  useLayoutEffect(() => {
    const element = row.current
    if (!element || items.length === 0) return
    const measure = (): void => {
      const style = getComputedStyle(element)
      const available =
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const widths = [...element.querySelectorAll<HTMLElement>(".pin")].map(
        (pin) => pin.offsetWidth,
      )
      setCount(pinsThatFit(available, widths, parseFloat(style.columnGap) || 0))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const pin of element.querySelectorAll(".pin")) observer.observe(pin)
    return () => observer.disconnect()
    // A drag's end remounts the pins, which are then observed again.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [items, drags])

  // Tells which show, once at first and then only when they change.
  const told = useRef<readonly string[] | null>(null)
  useLayoutEffect(() => {
    const ids = pins.slice(0, shown).map(({ id }) => id)
    const before = told.current
    if (before && before.length === ids.length && before.every((id, i) => id === ids[i])) return
    told.current = ids
    onShown(ids)
  }, [pins, shown, onShown])

  return (
    <div
      className="pins-bar"
      data-open={open ? "true" : undefined}
      data-animated={animated ? "true" : undefined}
      inert={!open}
    >
      <div className="pins-bar-clip">
        <div
          ref={rowRef}
          role="group"
          aria-label="Pinned projects"
          className="pins-bar-row flex items-stretch gap-0.5 px-2.5"
        >
          <DragDropProvider
            key={drags}
            sensors={sensors}
            modifiers={modifiers}
            plugins={(defaults) => [
              ...defaults.filter((plugin) => plugin !== Accessibility),
              feedback,
              cursor,
            ]}
            onDragStart={() => setDragging(true)}
            onDragEnd={(event) => {
              setDragging(false)
              setDrags((drag) => drag + 1)
              const { source } = event.operation
              if (!isSortable(source)) return
              const id = String(source.id)
              setFocusRequest({ id })
              if (event.canceled || source.initialIndex === source.index) return
              onMove(id, Math.min(source.index, pins.length - 1))
            }}
          >
            {items.map((project, index) => {
              // A project only working shows nothing: the bar stays still while agents work.
              const status = needsPerson(statuses[project.id]) ? statuses[project.id] : undefined
              return (
                <PinButton
                  key={project.id}
                  project={project}
                  index={index}
                  fits={index < shown}
                  last={index === shown - 1}
                  current={project.id === current}
                  status={status}
                  dragging={dragging}
                  focusRequest={focusRequest}
                  onFocused={() => setFocusRequest(null)}
                  onSelect={() => onSelect(project.id)}
                  onStep={(by) => {
                    setFocusRequest({ id: project.id })
                    onStep(project.id, by)
                  }}
                />
              )
            })}
          </DragDropProvider>
        </div>
      </div>
    </div>
  )
}

const PinButton = ({
  project,
  index,
  fits,
  last,
  current,
  status,
  dragging,
  focusRequest,
  onFocused,
  onSelect,
  onStep,
}: {
  project: Pin
  // Its place in the bar, which is its number less one.
  index: number
  // It has room to show.
  fits: boolean
  // No shown pin follows it, so it can't step right: the hidden ones are out of reach.
  last: boolean
  current: boolean
  status: ProjectStatus | undefined
  // Some pin is being dragged, which leaves no tooltip open.
  dragging: boolean
  // Asks the pin with this id to take the focus, as after a keyboard move or a drag.
  focusRequest: { id: string } | null
  // Told once the pin has taken the focus it was asked for.
  onFocused: () => void
  onSelect: () => void
  // Moves the project by one place.
  onStep: (by: -1 | 1) => void
}): React.JSX.Element => {
  // The pins that are hidden are no places to drop on.
  const { ref, isDragSource } = useSortable({
    id: project.id,
    index,
    disabled: !fits,
    transition: { duration: slide(), easing: ease },
  })
  const button = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (focusRequest?.id !== project.id) return
    button.current?.focus()
    onFocused()
  }, [focusRequest, project.id, onFocused])
  const shortcut = pinnedProjectShortcut(index)
  return (
    <Tooltip content={`${project.directory} · ${shortcut.display.join(" ")}`} disabled={dragging}>
      <button
        ref={(node) => {
          button.current = node
          ref(node)
        }}
        type="button"
        inert={!fits}
        style={fits ? undefined : { visibility: "hidden" }}
        className="pin flex min-w-0 max-w-50 shrink-0 items-center text-body"
        aria-current={current ? "true" : undefined}
        aria-keyshortcuts={[
          `${shortcut.meta ? "Meta" : "Control"}+${shortcut.key}`,
          ...(index > 0 ? ["Alt+ArrowLeft"] : []),
          ...(last ? [] : ["Alt+ArrowRight"]),
        ].join(" ")}
        aria-description={status && statusText[status]}
        data-project-status={status}
        data-dragging={isDragSource ? "true" : undefined}
        onClick={() => {
          if (!current) onSelect()
        }}
        onKeyDown={(event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault()
          const by = event.key === "ArrowLeft" ? -1 : 1
          // Stepping past the last pin would unpin it; the bar only reorders.
          if (by === 1 && last) return
          onStep(by)
        }}
      >
        <span aria-hidden="true" className="pin-number text-control">
          {index + 1}
        </span>
        <span className="pin-name min-w-0 truncate" data-text={project.name}>
          {project.name}
        </span>
        <span aria-hidden="true" className="project-status-mark pin-mark" />
      </button>
    </Tooltip>
  )
}

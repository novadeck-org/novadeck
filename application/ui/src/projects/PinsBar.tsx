import {
  Accessibility,
  Cursor,
  type DragDropManager,
  Feedback,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom"
import { RestrictToWindow } from "@dnd-kit/dom/modifiers"
import { DragDropProvider, useDragDropManager } from "@dnd-kit/react"
import { isSortable, useSortable } from "@dnd-kit/react/sortable"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"

import { pinnedProjectShortcut } from "../interaction/shortcuts"
import { Tooltip } from "../ui-toolkit/Tooltip"
import { usePinDrop, type Point } from "./pin-drop"
import { usePinHandoff } from "./pin-handoff"
import { ease, slide } from "./pin-motion"
import { pinsThatFit } from "./pins-fit"
import { needsPerson, statusText, type ProjectStatus } from "./project-status"

type Pin = { readonly id: string; readonly name: string; readonly directory: string }
type Line = { readonly left: number; readonly width: number; readonly slide: boolean }

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
const cursor = Cursor.configure({ cursor: "grabbing" })
const modifiers = [RestrictToWindow.configure({})]
// How far above or below the bar a dragged pin goes before letting it go unpins it.
const leeway = 24
// Well above or below the bar's strip, where letting a dragged pin go unpins it.
const offBar = (strip: HTMLElement | null, point: Point): boolean => {
  const box = strip?.getBoundingClientRect()
  return box !== undefined && (point.y < box.top - leeway || point.y > box.bottom + leeway)
}

// The pinned projects, as a bar under the header, in the person's order: each pin is its
// number (its shortcut's digit), its name and a mark of what its project's terminals ask
// of the person, and a click switches to it. The bar slides in with the first pin and out
// with the last. The current pin stays in its place, marked as current, so switching never
// moves the others, and a mark's slot is always there, so one appearing never does either.
// They take the room the bar leaves them: each shows whole or not at all, the last ones
// first to go, and `onShown` says which show. All stay in the bar so each can be measured;
// the ones that don't fit are hidden and inert.
// Pins drag along the bar into any order, and Alt with the left and right arrows moves the
// focused pin one place; `onMove` (to a place among the pins) and `onStep` tell the
// arrangement, which is the caller's. A pin dragged well off the bar shows it will go, and
// let go there it is unpinned (`onUnpin`); stepped, it never leaves the bar, as it can't
// pass the last pin shown.
// A project dragged out of the switcher's list (`usePinDrop`) comes in pinned, and the bar
// drags its pin on from the pointer as it would any pin's; an empty bar opens for such a
// drag, ready for the first.
export const PinsBar = ({
  pins,
  current,
  statuses,
  hidden = false,
  onSelect,
  onMove,
  onStep,
  onUnpin,
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
  onUnpin: (id: string) => void
  onShown: (ids: readonly string[]) => void
}): React.JSX.Element => {
  const { channel, drag, handoff } = usePinDrop()
  // A drag from the switcher's list that the bar can take.
  const dropping = drag?.accepts === true
  // The last pins stay while the bar slides out, but not in a bar opened for a drop.
  const [items, setItems] = useState(pins)
  if ((pins.length > 0 || dropping) && pins !== items) setItems(pins)
  const open = (pins.length > 0 || dropping) && !hidden

  // A page that loads with pins shows the bar as it is; only later changes slide.
  const [animated, setAnimated] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setAnimated(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const row = useRef<HTMLDivElement | null>(null)
  const feedback = useMemo(
    () => Feedback.configure({ dropAnimation: { duration: slide(), easing: ease } }),
    [],
  )
  // The pin that takes the focus, after a keyboard move or a drag; a new object asks again.
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null)
  // dnd-kit moves the dragged pin's element among its neighbours as it goes and puts it
  // back only in some drags, so every drag's end remounts the pins from the order, and the
  // focus is asked for again.
  const [drags, setDrags] = useState(0)
  const [dragging, setDragging] = useState(false)
  // The dragged pin is off the bar, where letting it go unpins it.
  const [leaving, setLeaving] = useState(false)
  const off = useRef(false)
  const [count, setCount] = useState(items.length)
  // As the bar slides out the pins stay as they were shown, so they slide away in view.
  const shown = Math.min(count, items.length)
  // The line under the current pin, where it shows: it slides from pin to pin, but is
  // put in place without sliding when it first shows and after a drag.
  const [line, setLine] = useState<Line | null>(null)
  const placed = useRef<{ drags: number; current: string } | null>(null)
  const strip = useRef<HTMLDivElement | null>(null)

  // Measures before paint, and again as the bar or a pin changes size.
  useLayoutEffect(() => {
    const element = row.current
    if (!element) return
    // An empty bar, open for a drop, has no line; the next shows without sliding.
    if (items.length === 0) {
      placed.current = null
      return
    }
    const measure = (): void => {
      const style = getComputedStyle(element)
      const available =
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const buttons = [...element.querySelectorAll<HTMLElement>(".pin")]
      const widths = buttons.map((button) => button.offsetWidth)
      const fit = pinsThatFit(available, widths, parseFloat(style.columnGap) || 0)
      setCount(fit)
      const index = items.findIndex(({ id }) => id === current)
      const pin = index >= 0 && index < fit ? buttons[index] : undefined
      if (!pin) {
        placed.current = null
        setLine(null)
        return
      }
      const next = { left: pin.offsetLeft, width: pin.offsetWidth }
      // Only a switch slides it: a pin moved by the keyboard or unpinned jumps at once, and
      // so does the line under it.
      const moves = placed.current?.drags === drags && placed.current.current !== current
      placed.current = { drags, current }
      setLine((was) =>
        was && was.left === next.left && was.width === next.width ? was : { ...next, slide: moves },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const pin of element.querySelectorAll(".pin")) observer.observe(pin)
    return () => observer.disconnect()
    // A drag's end remounts the pins, which are then observed again.
  }, [items, drags, current])

  // Where a point along the bar lands among the pins shown, the dragged project's own pin
  // aside, for a drag handed over from the switcher's list: before the first pin whose
  // middle is past it, or after the last.
  useLayoutEffect(() => {
    if (!channel) return
    channel.setLocate((point, id) => {
      const others = [...(row.current?.querySelectorAll<HTMLElement>(".pin:not([inert])") ?? [])]
        .filter((pin) => pin.dataset.pin !== id)
        .map((pin) => pin.getBoundingClientRect())
      const found = others.findIndex((pin) => point.x < pin.left + pin.width / 2)
      return found < 0 ? others.length : found
    })
    return () => channel.setLocate(null)
  }, [channel])

  // A drag handed over from the switcher's list, which the bar drags on as its pin.
  const { arriving, takeManager, end } = usePinHandoff(
    handoff,
    handoff !== null && items.some(({ id }) => id === handoff.id),
    row,
    () => channel?.settle(true),
  )
  // Off the bar, a dragged pin shows it will go, but a project pinned before it was handed
  // over stays pinned wherever it is let go.
  const unpinning = leaving && !handoff?.wasPinned

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
        <div ref={strip} className="pins-bar-strip flex items-stretch pl-3.5">
          {/* The chord before each pin's number, as a reminder; each pin names its own. */}
          <kbd className="hint self-center whitespace-nowrap" aria-hidden="true">
            {pinnedProjectShortcut(0).display.slice(0, -1).join(" ")} +
          </kbd>
          <div
            ref={row}
            role="group"
            aria-label="Pinned projects"
            className="pins-bar-row relative flex min-w-0 flex-1 items-stretch pl-2 pr-1"
            // A pin handed over from the switcher is dragged from the moment it arrives.
            data-dragging={dragging || arriving ? "true" : undefined}
            data-arriving={arriving ? "true" : undefined}
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
              onDragStart={() => {
                off.current = false
                setDragging(true)
              }}
              onDragMove={(event) => {
                const away = offBar(strip.current, event.to ?? event.operation.position.current)
                if (away === off.current) return
                off.current = away
                setLeaving(away)
              }}
              onDragEnd={(event) => {
                const { handedOver, releasedAt } = end()
                if (releasedAt) off.current = offBar(strip.current, releasedAt)
                const unpins = off.current && !event.canceled
                off.current = false
                setLeaving(false)
                setDragging(false)
                setDrags((made) => made + 1)
                // A handed-over drag let go off the bar, or canceled, puts everything back as
                // it was before it: the project was never placed.
                if (handedOver) channel?.settle(unpins || event.canceled)
                const { source } = event.operation
                if (!isSortable(source)) return
                const id = String(source.id)
                if (unpins) {
                  if (!handedOver) onUnpin(id)
                  return
                }
                setFocusRequest({ id })
                if (event.canceled || source.initialIndex === source.index) return
                onMove(id, Math.min(source.index, pins.length - 1))
              }}
            >
              <ManagerOf onManager={takeManager} />
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
                    leaving={unpinning}
                    arriving={project.id === arriving}
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
            {items.length === 0 && dropping && (
              <span className="pins-bar-empty mx-auto self-center text-label">
                Drop here to pin
              </span>
            )}
            {line && items.length > 0 && (
              <span
                className="pins-bar-indicator"
                data-slide={line.slide ? "true" : undefined}
                style={
                  {
                    "--_left": `${line.left}px`,
                    "--_width": `${line.width}px`,
                  } as React.CSSProperties
                }
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Hands the bar its drag manager, which a drag handed over from the switcher's list runs.
const ManagerOf = ({
  onManager,
}: {
  onManager: (manager: DragDropManager | null) => void
}): null => {
  const manager = useDragDropManager()
  useLayoutEffect(() => onManager(manager), [manager, onManager])
  return null
}

const PinButton = ({
  project,
  index,
  fits,
  last,
  current,
  status,
  dragging,
  leaving,
  arriving,
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
  // The pin being dragged is off the bar, and would be unpinned there.
  leaving: boolean
  // Handed over from the switcher, it isn't under the pointer yet.
  arriving: boolean
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
  // A pin being dragged shows, though it has no room in the bar, as one just handed over.
  const shows = fits || isDragSource
  const shortcut = pinnedProjectShortcut(index)
  return (
    <Tooltip content={`${project.directory} · ${shortcut.display.join(" ")}`} disabled={dragging}>
      <button
        ref={(node) => {
          button.current = node
          ref(node)
        }}
        type="button"
        data-pin={project.id}
        inert={!shows}
        style={shows ? undefined : { visibility: "hidden" }}
        className="pin flex min-w-0 max-w-50 shrink-0 items-center text-body"
        aria-current={current ? "true" : undefined}
        aria-keyshortcuts={[
          [
            shortcut.meta ? "Meta" : "Control",
            ...(shortcut.shift ? ["Shift"] : []),
            shortcut.key,
          ].join("+"),
          ...(index > 0 ? ["Alt+ArrowLeft"] : []),
          ...(last ? [] : ["Alt+ArrowRight"]),
        ].join(" ")}
        aria-description={status && statusText[status]}
        data-project-status={status}
        data-dragging={isDragSource ? "true" : undefined}
        data-leaving={isDragSource && leaving ? "true" : undefined}
        data-arriving={arriving ? "true" : undefined}
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

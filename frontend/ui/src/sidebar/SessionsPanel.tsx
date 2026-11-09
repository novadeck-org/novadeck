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
import { isSortable, useSortable } from "@dnd-kit/react/sortable"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { sidebarListClasses, SidebarItem } from "@novadeck/toolkit/SidebarItem"
import { SubjectBar, SubjectDetail, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Check, Layers2, Pencil, Plus, Trash2, X } from "lucide-react"
import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react"

import { shortcutBindings } from "../interaction/shortcuts"
import { sidebarCreateClasses } from "./SidebarPanel"

// What a session's terminals show at a glance, worded by the shell (projects/session-marks.ts):
// the status its mark draws (project-status.css), that status in words, the detail line's need
// word, and the tooltip's lines naming the terminals that need the person or ask.
export type SessionGlance = {
  readonly status: string | undefined
  readonly label: string | undefined
  readonly need: string | undefined
  readonly lines: readonly string[]
}

type WorkspaceSessionSummary = {
  id: string
  name: string
  // Null until the person first opens it.
  visitedAt: number | null
  terminalNames: string[]
  running: number
  // What its terminals show at a glance; none while they show nothing.
  mark?: SessionGlance | undefined
}

type SessionsPanelProps = {
  sessions: WorkspaceSessionSummary[]
  activeId: string
  onSelect: (id: string) => void
  onFresh: () => void
  // A blank name keeps the old one.
  onRename?: ((id: string, name: string) => void) | undefined
  // To this place in the list, as a drag drops it.
  onMove?: ((id: string, index: number) => void) | undefined
  // Deletes the session; never offered for the last one.
  onRemove?: ((id: string) => void) | undefined
  // Whether closed terminals are kept in History, where a deleted session's come back from.
  historyKept?: boolean
}

const timestamp = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

// The open session is open now, whenever it was last visited.
const formatVisited = (visitedAt: number | null, active: boolean): string =>
  active
    ? "Open now"
    : visitedAt === null
      ? "Not opened yet"
      : `Last visited ${timestamp.format(new Date(visitedAt))}`

const terminalsCount = (count: number): string =>
  `${count} ${count === 1 ? "terminal" : "terminals"}`

// A row follows the pointer once it has moved a few pixels, so a click still opens it; the
// keyboard picks one up with Space, as terminal tabs do.
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
const reorderId = "sessions"
const instructionsId = `dnd-kit-description-${reorderId}`
const accessibility = Accessibility.configure({
  id: reorderId,
  screenReaderInstructions: {
    draggable:
      "Press Enter to open a session. Press Space to pick it up, use arrow keys to reorder, then Space to drop or Escape to cancel.",
  },
})
const dropMs = 180
const feedback = Feedback.configure({
  dropAnimation: { duration: dropMs, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
})
const cursor = Cursor.configure({ cursor: "pointer" })

const actionClasses = "session-action icon-button small dim quiet"

// The session a delete asks about, as a window header names it.
const removeBar = (shown: WorkspaceSessionSummary): React.JSX.Element => (
  <SubjectBar>
    <SubjectSide>
      <Layers2 size={14} strokeWidth={1.5} aria-hidden="true" />
      <SubjectName>{shown.name}</SubjectName>
    </SubjectSide>
    <SubjectDetail end>{terminalsCount(shown.terminalNames.length)}</SubjectDetail>
  </SubjectBar>
)

// The field a session is renamed in: Enter saves, Escape cancels, and leaving it saves.
const SessionNameInput = ({
  id,
  name,
  onSave,
  onCancel,
}: {
  id: string
  name: string
  onSave: (name: string) => void
  onCancel: () => void
}): React.JSX.Element => {
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(name)
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true })
    input.current?.select()
  }, [])
  return (
    <input
      ref={input}
      data-rename-session={id}
      aria-label={`Rename ${name}`}
      value={value}
      maxLength={200}
      autoComplete="off"
      className="session-rename-input terminal-rename-input w-full text-body leading-[18px] font-medium"
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (event.key !== "Enter" && event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === "Enter") onSave(value)
        else onCancel()
      }}
      onBlur={(event) => {
        // Its own Save and Cancel answer for it.
        const next = event.relatedTarget
        if (
          next instanceof Element &&
          next.closest<HTMLElement>("[data-rename-session]")?.dataset.renameSession === id
        )
          return
        onSave(value)
      }}
    />
  )
}

const SessionRow = ({
  session,
  index,
  active,
  editing,
  removable,
  renamable,
  onSelect,
  onBeginRename,
  onRename,
  onCancelRename,
  onRemove,
}: {
  session: WorkspaceSessionSummary
  index: number
  active: boolean
  editing: boolean
  removable: boolean
  renamable: boolean
  onSelect: () => void
  onBeginRename: () => void
  onRename: (name: string) => void
  onCancelRename: () => void
  onRemove: () => void
}): React.JSX.Element => {
  const { ref, handleRef, isDragSource } = useSortable({
    id: session.id,
    index,
    disabled: editing,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  })
  const terminalCount = session.terminalNames.length
  const preview = terminalCount ? session.terminalNames.join(", ") : "No terminals yet"
  const visited = formatVisited(session.visitedAt, active)
  const { mark } = session
  const need = mark?.need
  const lines = mark?.lines ?? []
  const status = mark?.status
  const icon = <Layers2 size={14} strokeWidth={1.5} />
  const detail = (
    <>
      <span className="shrink-0">{terminalsCount(terminalCount)}</span>
      {/* It gives way to the actions beside it, never running under them. */}
      {need ? (
        <span className="session-running min-w-0 truncate">{need}</span>
      ) : (
        session.running > 0 && (
          <span className="session-running min-w-0 truncate">{session.running} running</span>
        )
      )}
    </>
  )
  return (
    <SidebarItem
      ref={ref}
      handleRef={handleRef}
      className={`sessions-panel-entry${active ? " active" : ""}${editing ? " editing" : ""}${isDragSource ? " dragging" : ""}`}
      role="listitem"
      data-workspace-session={session.id}
      name={session.name}
      icon={icon}
      selected={active}
      selectLabel={`Open ${session.name}`}
      describedBy={instructionsId}
      badge={
        status && (
          <span
            className="session-status flex shrink-0 items-center"
            data-project-status={status}
            aria-hidden="true"
          >
            <span className="project-status-mark" />
          </span>
        )
      }
      description={[...(mark?.label ? [mark.label] : []), visited, ...lines, preview].join(". ")}
      tooltip={[session.name, visited, ...lines, preview].join("\n")}
      onSelect={onSelect}
      onDoubleClick={renamable && !editing ? onBeginRename : undefined}
      detail={detail}
      editing={editing}
      editor={
        editing ? (
          <div className="session-rename flex min-w-0 flex-1 items-start gap-2 px-2.5 py-[9px] select-text">
            <span className="sidebar-item-icon flex h-[18px] w-3.5 shrink-0 items-center justify-center">
              {icon}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <SessionNameInput
                id={session.id}
                name={session.name}
                onSave={onRename}
                onCancel={onCancelRename}
              />
              <span className="sidebar-item-detail item-detail flex h-6 min-w-0 items-center gap-1.5 overflow-hidden pr-[52px] whitespace-nowrap text-caption leading-[18px]">
                {detail}
              </span>
            </div>
          </div>
        ) : undefined
      }
      actions={
        renamable || removable ? (
          <div className="session-actions flex items-center">
            {editing ? (
              <>
                <Tooltip content="Save">
                  <button
                    className={actionClasses}
                    type="button"
                    data-rename-session={session.id}
                    aria-label={`Save name for ${session.name}`}
                    onClick={(event) => {
                      const field = event.currentTarget
                        .closest(".sessions-panel-entry")
                        ?.querySelector<HTMLInputElement>("input[data-rename-session]")
                      onRename(field?.value ?? session.name)
                    }}
                  >
                    <Check size={14} strokeWidth={1.5} />
                  </button>
                </Tooltip>
                <Tooltip content="Cancel">
                  <button
                    className={actionClasses}
                    type="button"
                    data-rename-session={session.id}
                    aria-label={`Cancel renaming ${session.name}`}
                    onClick={onCancelRename}
                  >
                    <X size={14} strokeWidth={1.5} />
                  </button>
                </Tooltip>
              </>
            ) : (
              <>
                {renamable && (
                  <Tooltip content="Rename">
                    <button
                      className={`${actionClasses} session-action-revealed`}
                      type="button"
                      aria-label={`Rename ${session.name}`}
                      onClick={onBeginRename}
                    >
                      <Pencil size={14} strokeWidth={1.5} />
                    </button>
                  </Tooltip>
                )}
                {removable && (
                  <Tooltip content="Delete">
                    <button
                      className={`${actionClasses} session-action-revealed`}
                      type="button"
                      aria-label={`Delete ${session.name}`}
                      onClick={onRemove}
                    >
                      <Trash2 size={14} strokeWidth={1.5} />
                    </button>
                  </Tooltip>
                )}
              </>
            )}
          </div>
        ) : undefined
      }
    />
  )
}

export const SessionsPanel = ({
  sessions,
  activeId,
  onSelect,
  onFresh,
  onRename,
  onMove,
  onRemove,
  historyKept = false,
}: SessionsPanelProps): React.JSX.Element => {
  const shortcut = shortcutBindings().newSession.display.join(" ")
  const [list, setList] = useState<HTMLDivElement | null>(null)
  // The session being renamed.
  const [editing, setEditing] = useState<string | null>(null)
  // The session a delete asks about, while it asks.
  const [removing, setRemoving] = useState<WorkspaceSessionSummary | null>(null)
  // Bumped as a drag ends: the drag library moves a row's element among the others, which
  // React can't follow, so the rows mount anew in the saved order. `focus` is the row a
  // keyboard drag moved, which the new rows give the focus back to.
  const [drag, setDrag] = useState<{ generation: number; focus: string | null }>({
    generation: 0,
    focus: null,
  })
  useLayoutEffect(() => {
    const { focus } = drag
    if (focus === null) return
    const give = (): void => {
      const row = [...(list?.querySelectorAll<HTMLElement>("[data-workspace-session]") ?? [])].find(
        (each) => each.dataset.workspaceSession === focus,
      )
      row?.querySelector<HTMLElement>("button")?.focus()
    }
    give()
    // As a keyboard drop settles, dnd-kit gives the focus to the row it dragged, which may be
    // the element these rows replaced (a race, most often with reduced motion, where no drop
    // animation runs); a focus lost to that comes back.
    const again = setTimeout(() => {
      const held = document.activeElement
      if (!held || held === document.body || !held.isConnected) give()
    }, dropMs + 120)
    return () => clearTimeout(again)
  }, [drag, list])
  const modifiers = useMemo(() => [RestrictToElement.configure({ element: list })], [list])
  const removable = Boolean(onRemove) && sessions.length > 1
  const remove = (session: WorkspaceSessionSummary): void => {
    // An empty session goes at once; one with terminals asks first, as they close.
    if (session.terminalNames.length) setRemoving(session)
    else onRemove?.(session.id)
  }
  return (
    <div className="sessions-panel flex min-h-0 min-w-0 w-full flex-1 flex-col">
      <Tooltip content={`New session · ${shortcut}`}>
        <button
          className={sidebarCreateClasses}
          type="button"
          aria-label="New session"
          data-sessions-create
          onClick={onFresh}
        >
          <Plus size={14} className="shrink-0" />
          <span className="min-w-0 truncate">Session</span>
          <kbd className="hint mb-[-2px] ml-auto shrink-0 whitespace-nowrap">{shortcut}</kbd>
        </button>
      </Tooltip>
      <DragDropProvider
        sensors={sensors}
        modifiers={modifiers}
        plugins={(defaults) => [...defaults, accessibility, feedback, cursor]}
        onDragEnd={(event) => {
          const { source, activatorEvent } = event.operation
          if (!isSortable(source)) return
          // A drag from the keyboard leaves the focus on the session it moved. Where the focus
          // stands as it ends can't say: moving the row's element may have dropped it.
          const keyboard = activatorEvent instanceof KeyboardEvent
          setDrag((current) => ({
            generation: current.generation + 1,
            focus: keyboard ? String(source.id) : null,
          }))
          if (event.canceled || source.initialIndex === source.index) return
          onMove?.(String(source.id), source.index)
        }}
      >
        <div
          className={`sessions-panel-list ${sidebarListClasses}`}
          role="list"
          aria-label="Saved sessions"
          ref={setList}
        >
          <Fragment key={drag.generation}>
            {sessions.map((session, index) => (
              <SessionRow
                key={session.id}
                session={session}
                index={index}
                active={session.id === activeId}
                editing={editing === session.id}
                removable={removable}
                renamable={Boolean(onRename)}
                onSelect={() => onSelect(session.id)}
                onBeginRename={() => setEditing(session.id)}
                onRename={(name) => {
                  setEditing(null)
                  onRename?.(session.id, name)
                }}
                onCancelRename={() => setEditing(null)}
                onRemove={() => remove(session)}
              />
            ))}
          </Fragment>
        </div>
      </DragDropProvider>
      <ConfirmDialog
        subject={removing}
        bar={removeBar}
        title={() => "Delete this session?"}
        description={(shown) => {
          const one = shown.terminalNames.length === 1
          const closes = one
            ? "Its terminal closes."
            : `Its ${shown.terminalNames.length} terminals close.`
          return historyKept
            ? `${closes} You can bring ${one ? "it" : "them"} back from History.`
            : closes
        }}
        confirmLabel="Delete session"
        cancelLabel="Cancel"
        onConfirm={() => {
          if (removing) onRemove?.(removing.id)
          setRemoving(null)
        }}
        onCancel={() => setRemoving(null)}
        returnFocus={(shown) =>
          list?.querySelector<HTMLElement>(
            `[data-workspace-session="${shown.id}"] .sidebar-item-select`,
          ) ?? null
        }
        widthClassName="w-[min(360px,calc(100vw-32px))]"
      />
    </div>
  )
}

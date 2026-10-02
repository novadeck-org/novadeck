import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { companionKeyId, type CompanionKey } from "../../model/companion"
import type { MovableItem, Placement } from "../../model/companion-items"
import type { WindowPlace } from "../../model/layout/window-place"
import type { Messages } from "../../model/messages"
import type { ViewMode } from "../../model/types"
import { usePresence, type Presence } from "../../ui-toolkit/presence"
import { useDrag, type BarDrag } from "../drag-session"
import type { TerminalLayoutControls } from "../WindowShell"
import { barMembers, composeBar, moveSlot, onBar, type BarMember } from "./bar"
import { CompanionPane } from "./CompanionPane"
import { useMail, type MailHandle } from "./mail"
import { closePane, movableOf, openTab, seen, shownTab } from "./pane"
import { presentationOf, type Panes } from "./state"
import { Taskbar } from "./Taskbar"
import type { SlotActions } from "./TaskbarSlot"
import type { Dragged } from "./use-bar-drag"
import { usePane, usePanesOf, type PaneHandle } from "./use-panes"

import "./companion.css"

// What the app does with a terminal's items beyond its own pane, as its commands do.
export type ItemCommands = {
  readonly undock: (from: string, item: MovableItem, place?: WindowPlace) => void
  readonly place: (placements: readonly Placement[]) => void
  readonly closeItem: (from: string, key: string) => void
}

const none: readonly never[] = []
const unnamed = (): undefined => undefined

const clamp = (value: number): number => Math.min(0.7, Math.max(0.22, value))

// What the pane shows, wherever it's presented.
type PaneView = {
  readonly pane: PaneHandle
  readonly member: BarMember | undefined
  readonly panes: Panes
  readonly mail: MailHandle
  readonly peerName: (handle: string) => string | undefined
  readonly originOf: (member: BarMember) => string
  readonly onUndock: (member: BarMember) => void
}

// Terminal left, pane right, inside the terminal's own window. The divider drags.
const SplitPane = ({
  view: shown,
  terminalView,
  presence,
  children,
}: {
  view: PaneView
  terminalView: ViewMode
  presence: Presence
  children: ReactNode
}): React.JSX.Element => {
  const [ratio, setRatio] = useState(terminalView === "focus" ? 0.36 : 0.42)
  const frame = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={frame}
      className="plan-split"
      style={{ "--plan-terminal": `${ratio * 100}%` } as React.CSSProperties}
    >
      <div className="plan-split-terminal">{children}</div>
      <div
        className="plan-divider nodrag nopan"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize plan"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={22}
        aria-valuemax={70}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setRatio((value) => clamp(value - 0.04))
          if (event.key === "ArrowRight") setRatio((value) => clamp(value + 0.04))
        }}
        onPointerDown={(event) => {
          const bounds = frame.current?.getBoundingClientRect()
          if (!bounds) return
          event.currentTarget.setPointerCapture(event.pointerId)
          const move = (next: PointerEvent): void =>
            setRatio(clamp((next.clientX - bounds.left) / bounds.width))
          const target = event.currentTarget
          target.addEventListener("pointermove", move)
          target.addEventListener(
            "pointerup",
            () => target.removeEventListener("pointermove", move),
            { once: true },
          )
        }}
      />
      <div {...presence.props} className="plan-split-reader nodrag nopan nowheel">
        <CompanionPane {...shown} presentation="split" />
      </div>
    </div>
  )
}

// Canvas units, matching .plan-attached.
const attachedExtent = { right: 20 + 720, height: 560 }

// A sheet hanging off the canvas node's right edge, so it pans and zooms with it. It is
// positioned against the node, outside the window's clipping.
const AttachedPane = ({
  view: shown,
  onReveal,
  presence,
}: {
  view: PaneView
  onReveal: TerminalLayoutControls["onReveal"]
  presence: Presence
}): React.JSX.Element => {
  // Frame once as the sheet opens, not whenever the canvas hands over a new callback.
  const reveal = useRef(onReveal)
  useEffect(() => reveal.current?.(attachedExtent), [])
  return (
    <div {...presence.props} className="plan-attached nodrag nopan nowheel">
      <CompanionPane {...shown} presentation="attached" />
    </div>
  )
}

// A terminal's companion: its taskbar, and the pane it opens in the terminal's own
// window or beside its canvas node. It wraps every terminal of a backend that reports
// companions or messages, so the terminal keeps its content when its agent first shows
// something.
export const TerminalCompanion = ({
  panes,
  messages,
  peerName,
  companionKey,
  view,
  onReveal,
  children,
  minimized,
  clipContent,
  undocked = none,
  placements = none,
  terminalName = unnamed,
  items,
}: {
  panes: Panes
  messages?: Messages | undefined
  // The name of the terminal in this session with that handle, if it has one.
  peerName: (handle: string) => string | undefined
  companionKey: CompanionKey
  view: ViewMode
  onReveal?: TerminalLayoutControls["onReveal"]
  children: ReactNode
  minimized?: boolean | undefined
  clipContent?: boolean | undefined
  // This terminal's items undocked into windows of their own now, by their keys.
  undocked?: readonly string[] | undefined
  // The session's items placed on taskbars other than their own.
  placements?: readonly Placement[] | undefined
  // A terminal in this session by its id, as it's named.
  terminalName?: ((terminalId: string) => string | undefined) | undefined
  items: ItemCommands
}): React.JSX.Element => {
  const terminal = companionKey.terminalId
  const pane = usePane(panes, companionKey)
  const mail = useMail(messages, companionKey)
  // Where what's placed here comes from: only those terminals' panes, so a keystroke in
  // any other plan re-renders nothing here.
  const sources = useMemo(
    () =>
      placements
        .filter((placement) => placement.to === terminal)
        .map((placement) => companionKeyId({ ...companionKey, terminalId: placement.from })),
    [placements, terminal, companionKey],
  )
  const sourcePanes = usePanesOf(panes, sources)
  const { slots, away } = useMemo(() => {
    const bar = barMembers({
      pane: pane.pane,
      undocked,
      placements,
      messages: mail.present,
      panes: sourcePanes,
    })
    return { slots: composeBar(pane.pane, bar.members), away: bar.away }
  }, [pane.pane, undocked, placements, mail.present, sourcePanes])
  const keys = onBar(slots)
  const tab = shownTab(pane.pane, (key) => keys.has(key))
  // Open while there's something to show. What the pane was opened to may be away, as
  // something the agent was asked to show again while it's undocked: it shows there, and
  // the pane stays hidden.
  const open = pane.pane.open && !minimized && !away.has(pane.pane.tab) && tab !== ""
  const showing = open ? tab : ""
  const member = slots.flatMap((slot) => slot.members).find((each) => each.id === tab)

  // An icon dragged off another terminal's bar is over this terminal: a drop on its bar
  // lands here.
  const hovered = useDrag(
    (drag) => drag !== null && drag.from !== terminal && drag.over === terminal,
  )
  const overBar = useDrag(
    (drag) => drag !== null && drag.from !== terminal && drag.over === terminal && drag.onBar,
  )

  // Opens a member in this pane. One placed here is seen in its own terminal's pane too.
  const openMember = (id: string): void => {
    pane.update((current) => openTab(current, id))
    const placed = slots
      .flatMap((slot) => slot.members)
      .find((each) => each.id === id && each.placed)
    if (placed) panes.of(placed.source).update((current) => seen(current, placed.key))
  }
  const originOf = (each: BarMember): string =>
    terminalName(each.source.terminalId) ?? "another terminal"
  const undockMember = (each: BarMember, place?: WindowPlace): void => {
    const item = movableOf(each.key)
    if (item && !each.placed) items.undock(terminal, item, place)
  }
  const actions: Omit<SlotActions, "grab"> = {
    showing,
    mail,
    peerName,
    originOf,
    loadOf: (each) => panes.of(each.source).load,
    // Clicking what the pane is showing hides it, as a taskbar minimizes the active window.
    activate: (id) => (id === showing ? pane.update(closePane) : openMember(id)),
    open: openMember,
    close: (each) => items.closeItem(each.source.terminalId, each.key),
    sendBack: (each) => {
      const item = movableOf(each.key)
      const home = each.source.terminalId
      if (item) items.place([{ from: home, item, to: home }])
    },
    undock: (each) => undockMember(each),
    move: (from, to) => pane.update((current) => moveSlot(current, slots, from, to)),
  }
  // Dropped on another terminal's bar, what was dragged shows there, a stack's each; back on
  // its own terminal's, it goes home. Dropped on free space, it undocks there.
  const land = (dragged: Dragged, ended: BarDrag): boolean => {
    const { over, place } = ended
    if (ended.onBar && over && over !== terminal) {
      items.place(
        dragged.members.flatMap((each) => {
          const item = movableOf(each.key)
          return item ? [{ from: each.source.terminalId, item, to: over }] : []
        }),
      )
      return true
    }
    const [only] = dragged.members
    if (place && dragged.undocks && only) {
      undockMember(only, place)
      return true
    }
    return false
  }

  const trigger = useRef<HTMLButtonElement>(null)
  const presentation = presentationOf(view)
  const present = slots.length > 0
  // The pane stays while it animates out. Only the pane animates: the terminal beside
  // it takes its new size once, never frame by frame.
  const shown = usePresence(open)
  // The taskbar too, once the terminal first has something to show.
  const bar = usePresence(present)
  // And an empty one to drop on, while an icon is dragged over a terminal without a bar.
  const emptyBar = usePresence(hovered && !present)
  const wasOpen = useRef(open)
  // Opening leaves focus on the taskbar. Hiding the pane from inside it (Escape) would
  // drop focus with the pane, so it goes back to the taskbar.
  useEffect(() => {
    const lost = !document.activeElement || document.activeElement === document.body
    if (!open && wasOpen.current && lost) trigger.current?.focus({ preventScroll: true })
    wasOpen.current = open
  }, [open])
  const paneView: PaneView = {
    pane,
    member,
    panes,
    mail,
    peerName,
    originOf,
    onUndock: actions.undock,
  }
  return (
    <div
      className="terminal-plan"
      data-plan-open={open}
      hidden={minimized && !clipContent}
      aria-hidden={minimized}
      inert={minimized}
    >
      {shown.mounted && presentation === "split" ? (
        <SplitPane view={paneView} terminalView={view} presence={shown}>
          {children}
        </SplitPane>
      ) : (
        children
      )}
      {/* A terminal gains its taskbar once its agent has a plan, shows something, or can
          message others, or once another terminal's item is placed on it. */}
      {bar.mounted && (
        <Taskbar
          terminal={terminal}
          agent={pane.pane.plans[0]?.agent ?? "The agent"}
          slots={slots}
          actions={actions}
          land={land}
          trigger={trigger}
          open={open}
          onHide={() => pane.update(closePane)}
          presence={bar}
          dropTarget={overBar}
        />
      )}
      {/* Nothing to show yet, but an icon is dragged over: an empty bar to drop it on. It
          gives way to the real bar at once once something lands. */}
      {emptyBar.mounted && !bar.mounted && (
        <div
          {...emptyBar.props}
          className="plan-taskbar plan-taskbar-empty nodrag nopan"
          data-taskbar=""
          data-drop-target={overBar || undefined}
        >
          <span className="plan-tb-empty-hint">Drop here to show it on this terminal</span>
        </div>
      )}
      {shown.mounted && presentation === "attached" && (
        <AttachedPane view={paneView} onReveal={onReveal} presence={shown} />
      )}
    </div>
  )
}

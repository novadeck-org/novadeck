import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import type { CompanionItem, CompanionKey, ItemId } from "../../model/companion"
import { messagesKey, type Bar, type BarKey } from "../../model/companion-bar"
import type { WindowPlace } from "../../model/layout/window-place"
import type { Messages } from "../../model/messages"
import type { ViewMode } from "../../model/types"
import { usePresence, type Presence } from "../../ui-toolkit/presence"
import { useDrag, type BarDrag } from "../drag-session"
import type { TerminalLayoutControls } from "../WindowShell"
import { barMembers, composeBar, dropOutcome, shownTab, slotKeys, type BarMember } from "./bar"
import { CompanionPane } from "./CompanionPane"
import { useMail } from "./mail"
import { presentationOf, type Panes } from "./state"
import { Taskbar } from "./Taskbar"
import type { SlotActions } from "./TaskbarSlot"
import type { Dragged } from "./use-bar-drag"
import { usePlans } from "./use-panes"

// What the app does with a terminal's bar and the items on it, as its commands do.
export type ItemCommands = {
  readonly undock: (itemId: ItemId, place?: WindowPlace) => void
  readonly place: (itemIds: readonly ItemId[], terminalId: string) => void
  readonly closeItem: (itemId: ItemId) => void
  readonly openBarTab: (terminalId: string, key: BarKey) => void
  readonly closeBarPane: (terminalId: string) => void
  readonly hideOnBar: (terminalId: string, key: BarKey) => void
  readonly moveBarSlot: (
    terminalId: string,
    slots: readonly (readonly BarKey[])[],
    from: number,
    to: number,
  ) => void
}

const unnamed = (): undefined => undefined

const clamp = (value: number): number => Math.min(0.7, Math.max(0.22, value))

// What the pane shows, wherever it's presented.
type PaneView = Omit<Parameters<typeof CompanionPane>[0], "presentation">

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
      style={{ "--_plan-terminal": `${ratio * 100}%` } as React.CSSProperties}
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
  bar,
  items,
  fresh,
  terminalName = unnamed,
  commands,
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
  // The bar as the person arranged it, the items on it, and which of them are new.
  bar: Bar
  items: readonly CompanionItem[]
  fresh: Readonly<Record<ItemId, true>>
  // A terminal in this session by its id, as it's named.
  terminalName?: ((terminalId: string) => string | undefined) | undefined
  commands: ItemCommands
}): React.JSX.Element => {
  const { terminalId: terminal, projectId, workspaceSessionId } = companionKey
  const target = useMemo(() => ({ projectId, workspaceSessionId }), [projectId, workspaceSessionId])
  const mail = useMail(messages, companionKey)
  const members = useMemo(
    () => barMembers({ terminalId: terminal, bar, items, fresh, messages: mail.present }),
    [terminal, bar, items, fresh, mail.present],
  )
  const slots = useMemo(() => composeBar(bar, members), [bar, members])
  const planIds = useMemo(
    () => items.flatMap((item) => (item.kind === "plan" ? [item.id] : [])),
    [items],
  )
  const plans = usePlans(panes, planIds)
  const tab = shownTab(bar, members)
  // Open while there's something to show.
  const open = bar.open && !minimized && tab !== null
  const showing = open ? tab : null
  const member = members.find((each) => each.key === tab)
  // Who showed what's here, by its main plan's agent.
  const agent =
    items.find((item) => item.kind === "plan" && item.plan?.role === "root")?.plan?.agent ??
    "The agent"

  // An icon dragged off another terminal's bar is over this terminal: a drop on its bar
  // lands here.
  const hovered = useDrag(
    (drag) => drag !== null && drag.from !== terminal && drag.over === terminal,
  )
  const overBar = useDrag(
    (drag) => drag !== null && drag.from !== terminal && drag.over === terminal && drag.onBar,
  )

  const originOf = (each: BarMember): string | undefined =>
    each.kind === "item" ? terminalName(each.item.from.terminalId) : undefined
  // The person picked something that may hold secrets: it shows.
  const picked = (key: BarKey): void => {
    const found = members.find((each) => each.key === key)
    if (found?.kind === "item" && found.item.held) panes.reveal(target, found.key)
  }
  const openPicked = (key: BarKey): void => {
    picked(key)
    commands.openBarTab(terminal, key)
  }
  const undockMember = (each: BarMember, place?: WindowPlace): void => {
    if (each.kind !== "item" || each.placed) return
    picked(each.key)
    commands.undock(each.key, place)
  }
  const actions: Omit<SlotActions, "grab"> = {
    showing,
    mail,
    peerName,
    originOf,
    plans,
    panes,
    target,
    // Clicking what the pane is showing hides it, as a taskbar minimizes the active window.
    activate: (key) => (key === showing ? commands.closeBarPane(terminal) : openPicked(key)),
    open: openPicked,
    close: (each) =>
      each.kind === "messages"
        ? commands.hideOnBar(terminal, messagesKey)
        : commands.closeItem(each.key),
    sendBack: (each) => {
      if (each.kind === "item") commands.place([each.key], each.item.from.terminalId)
    },
    undock: (each) => undockMember(each),
    move: (from, to) => commands.moveBarSlot(terminal, slotKeys(slots), from, to),
  }
  // Dropped on another terminal's bar, what was dragged moves there, a stack's each.
  // Dropped on free space, it undocks there.
  const land = (dragged: Dragged, ended: BarDrag): boolean => {
    const outcome = dropOutcome(dragged.members, ended, terminal)
    if (outcome?.kind === "place") commands.place(outcome.itemIds, outcome.terminalId)
    if (outcome?.kind === "undock") {
      picked(outcome.itemId)
      commands.undock(outcome.itemId, outcome.place)
    }
    return outcome !== null
  }

  const trigger = useRef<HTMLButtonElement>(null)
  const presentation = presentationOf(view)
  const present = slots.length > 0
  // The pane stays while it animates out. Only the pane animates: the terminal beside
  // it takes its new size once, never frame by frame.
  const shown = usePresence(open)
  // The taskbar too, once the terminal first has something to show.
  const taskbar = usePresence(present)
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
    member,
    panes,
    target,
    agent,
    mail,
    peerName,
    originOf,
    onUndock: actions.undock,
    onHide: () => commands.closeBarPane(terminal),
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
      {taskbar.mounted && (
        <Taskbar
          terminal={terminal}
          agent={agent}
          slots={slots}
          actions={actions}
          land={land}
          trigger={trigger}
          open={open}
          onHide={() => commands.closeBarPane(terminal)}
          presence={taskbar}
          dropTarget={overBar}
        />
      )}
      {/* Nothing to show yet, but an icon is dragged over: an empty bar to drop it on. It
          gives way to the real bar at once once something lands. */}
      {emptyBar.mounted && !taskbar.mounted && (
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

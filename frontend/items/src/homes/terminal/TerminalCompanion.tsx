import { isOnBar, type Item, type ItemId } from "@novadeck/core/items"
import { messagesKey, type Bar, type BarKey } from "@novadeck/core/items/companion-bar"
import type { WindowPlace } from "@novadeck/core/layout/window-place"
import type { Messages } from "@novadeck/core/messages"
import type { TerminalKey, ViewMode } from "@novadeck/core/types"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { usePresence, type Presence } from "@novadeck/toolkit/presence"
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"

import type { CompanionActions } from "../../actions"
import {
  barMembers,
  behindTab,
  composeBar,
  dropOutcome,
  shownTab,
  slotKeys,
  type BarMember,
} from "../../bar/bar"
import { useDrag, type BarDrag } from "../../bar/drag-session"
import { Taskbar } from "../../bar/Taskbar"
import type { SlotActions } from "../../bar/TaskbarSlot"
import type { Dragged } from "../../bar/use-bar-drag"
import { stuckEdits } from "../../kinds/plan/plan-doc"
import type { ItemStore } from "../../store/item-store"
import { usePlans } from "../../store/use-item-store"
import { CompanionPane } from "./CompanionPane"
import { coverKey } from "./cover-keys"
import { terminalDrawing } from "./drawing"
import { useMessages, type MessageLinks } from "./messages/messages"
import { presentationOf } from "./presentation"

// What the app does with a terminal's bar and the items on it: the actions but docking, which
// only a window's menu does.
export type ItemCommands = Omit<CompanionActions, "dock">

// How far the pane reaches into its window, as the window wants to know when it opens.
type Reveal = (extent: { readonly right: number; readonly height: number }) => void

const unnamed = (): undefined => undefined

const clamp = (value: number): number => Math.min(0.7, Math.max(0.22, value))

// What the pane shows, wherever it's presented.
type PaneView = Omit<Parameters<typeof CompanionPane>[0], "presentation">

// Terminal left, pane right, inside the terminal's own window. The divider drags. Where the
// window is too narrow for both the pane covers the terminal, which keeps its size beneath;
// its keys then uncover it (cover-keys.ts).
const SplitPane = ({
  view: shown,
  owner,
  terminalView,
  presence,
  children,
}: {
  view: PaneView
  owner: string
  terminalView: ViewMode
  presence: Presence
  children: ReactNode
}): React.JSX.Element => {
  const [ratio, setRatio] = useState(terminalView === "focus" ? 0.36 : 0.42)
  const frame = useRef<HTMLDivElement>(null)
  const { leaving, onHide } = shown
  const hide = useRef(onHide)
  useEffect(() => {
    hide.current = onHide
  })
  // Heard in the capture phase, past the app's own shortcuts, which stop their keys first,
  // and before the terminal's input.
  useEffect(() => {
    const element = frame.current
    const terminal = element?.querySelector(".pane-split-terminal")
    const pane = element?.querySelector(".pane-split-reader")
    if (leaving || !element || !terminal || !pane) return
    const heard = (event: KeyboardEvent): void =>
      coverKey(event, {
        covering: () => getComputedStyle(element).getPropertyValue("--_pane-cover").trim() === "1",
        terminal,
        pane,
        uncover: () => hide.current(),
        // A key pressed elsewhere makes no events in the terminal's input, so it goes there
        // as the same key's events, which the terminal reads by its code: its keydown, taking
        // it unless it's left to the keypress after.
        type: (pressed) => {
          const input = terminal.querySelector<HTMLElement>("[data-terminal-input]")
          if (!input) return
          input.focus({ preventScroll: true })
          const key = {
            key: pressed.key,
            code: pressed.code,
            keyCode: pressed.keyCode,
            shiftKey: pressed.shiftKey,
            bubbles: true,
            cancelable: true,
          }
          if (input.dispatchEvent(new KeyboardEvent("keydown", key)))
            input.dispatchEvent(
              new KeyboardEvent("keypress", { ...key, charCode: pressed.key.charCodeAt(0) }),
            )
        },
      })
    document.addEventListener("keydown", heard, true)
    return () => document.removeEventListener("keydown", heard, true)
  }, [leaving])
  return (
    <div
      ref={frame}
      className="pane-split"
      style={{ "--_pane-terminal": `${ratio * 100}%` } as React.CSSProperties}
    >
      <div className="pane-split-terminal">{children}</div>
      <div
        className="pane-divider nodrag nopan"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize pane"
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
      <div
        {...presence.props}
        className="pane-split-reader nodrag nopan nowheel"
        data-companion-of={owner}
      >
        <CompanionPane {...shown} presentation="split" />
      </div>
    </div>
  )
}

// Canvas units, matching .pane-attached.
const attachedExtent = { right: 20 + 720, height: 560 }

// Where an attached sheet hangs: the canvas node around the window, which the window's
// clipping (its overflow and paint containment) doesn't reach. Null until the node has
// mounted; left unset, as outside a canvas node, the sheet stays where it's rendered.
export const AttachedContainer = createContext<HTMLElement | null | undefined>(undefined)

// A sheet hanging off the canvas node's right edge, so it pans and zooms with it. It is
// positioned against the node, outside the window's clipping. Hung there, outside its
// terminal's region too, the region owns it, so assistive technology still finds it there.
const AttachedPane = ({
  view: shown,
  owner,
  within,
  onReveal,
  presence,
}: {
  view: PaneView
  owner: string
  // Inside the terminal's window, wherever the sheet hangs.
  within: React.RefObject<HTMLElement | null>
  onReveal: Reveal | undefined
  presence: Presence
}): React.JSX.Element | null => {
  // Frame once as the sheet opens, not whenever the canvas hands over a new callback.
  const reveal = useRef(onReveal)
  useEffect(() => reveal.current?.(attachedExtent), [])
  const container = useContext(AttachedContainer)
  const id = useId()
  useEffect(() => {
    const region = container ? within.current?.closest("[data-terminal]") : undefined
    if (!region) return
    region.setAttribute("aria-owns", id)
    return () => region.removeAttribute("aria-owns")
  }, [container, within, id])
  const sheet = (
    <div
      {...presence.props}
      id={id}
      className="pane-attached nodrag nopan nowheel"
      data-companion-of={owner}
    >
      <CompanionPane {...shown} presentation="attached" />
    </div>
  )
  if (container === undefined) return sheet
  return container ? createPortal(sheet, container) : null
}

// A terminal's companion: its taskbar, and the pane it opens in the terminal's own
// window or beside its canvas node. It wraps every terminal of a backend that reports
// companions or messages, so the terminal keeps its content when its agent first shows
// something.
export const TerminalCompanion = ({
  itemStore,
  messages,
  links,
  terminalKey,
  view,
  onReveal,
  children,
  bar,
  items,
  fresh,
  terminalName = unnamed,
  commands,
}: {
  itemStore: ItemStore
  messages?: Messages | undefined
  // The session around the terminal, as its messages show it.
  links: MessageLinks
  terminalKey: TerminalKey
  view: ViewMode
  onReveal?: Reveal | undefined
  children: ReactNode
  // The bar as the person arranged it, the items on it, and which of them are new.
  bar: Bar
  items: readonly Item[]
  fresh: Readonly<Record<ItemId, true>>
  // A terminal in this session by its id, as it's named.
  terminalName?: ((terminalId: string) => string | undefined) | undefined
  commands: ItemCommands
}): React.JSX.Element => {
  const { terminalId: terminal, projectId, workspaceSessionId } = terminalKey
  const target = useMemo(() => ({ projectId, workspaceSessionId }), [projectId, workspaceSessionId])
  const messagesHandle = useMessages(messages, terminalKey)
  const members = useMemo(
    () =>
      barMembers({ terminalId: terminal, bar, items, fresh, messages: messagesHandle.hasMessages }),
    [terminal, bar, items, fresh, messagesHandle.hasMessages],
  )
  const slots = useMemo(() => composeBar(bar, members), [bar, members])
  const planIds = useMemo(
    () => items.flatMap((item) => (item.kind === "plan" ? [item.id] : [])),
    [items],
  )
  const plans = usePlans(itemStore, planIds)
  const tab = shownTab(bar, members)
  // A plan the person closes while edits in it can't reach its file: asked first, since
  // closing loses them.
  const [closing, setClosing] = useState<Item | null>(null)
  // Open while there's something to show.
  const open = bar.open && tab !== null
  const showing = open ? tab : null
  // What the pane last showed: as it animates out it keeps showing that, as when its only
  // sheet was minimized, or nothing once that's gone, never what it would fall back to.
  const [lastShown, setLastShown] = useState<BarKey | null>(showing)
  if (showing !== null && showing !== lastShown) setLastShown(showing)
  const paneTab = open ? tab : members.some((each) => each.key === lastShown) ? lastShown : null
  // What's open in the pane behind what it shows, nearest first, counted against what it
  // shows even as it hides, so its sheets stay as they were while it animates out.
  const behind = behindTab(bar, members, paneTab)
    .toReversed()
    .flatMap((key) => members.filter((each) => each.key === key))
  const member = members.find((each) => each.key === paneTab)
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
    each.kind === "item" && each.item.from ? terminalName(each.item.from.terminalId) : undefined
  // The person picked something that may hold secrets: it shows.
  const picked = (key: BarKey): void => {
    const found = members.find((each) => each.key === key)
    if (found?.kind === "item" && found.item.secret) itemStore.reveal(found.key, found.item.path)
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
    stacked: bar.stack,
    draw: terminalDrawing({ itemStore, target, messagesHandle, links, plans }),
    originOf,
    // Clicking what the pane is showing minimizes it, as a taskbar does the active window;
    // anything else comes to the top.
    activate: (key) => (key === showing ? commands.minimizeOnBar(terminal, key) : openPicked(key)),
    open: openPicked,
    seen: (itemIds) => commands.markSeen(itemIds),
    close: (each) => {
      if (each.kind === "messages") return commands.hideOnBar(terminal, messagesKey)
      // On its own terminal's bar a plan only hides, keeping its edits.
      const plan = itemStore.store.getSnapshot().plans[each.key]
      if (
        each.item.kind === "plan" &&
        each.item.from &&
        !isOnBar(each.item, each.item.from.terminalId) &&
        plan &&
        stuckEdits(plan, itemStore.store.getSnapshot().content[each.key])
      )
        return setClosing(each.item)
      commands.closeItem(each.key)
    },
    sendBack: (each) => {
      if (each.kind === "item" && each.item.from)
        commands.place([each.key], each.item.from.terminalId)
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
  const within = useRef<HTMLDivElement>(null)
  // Opening leaves focus on the taskbar. Hiding the pane from inside it (Escape) would
  // drop focus with the pane, which stays a moment as it animates out, so it goes back
  // to the taskbar, or to the terminal once closing what it showed left the bar empty.
  // Only focus the person had in the pane goes to the terminal, so a pane closed for them
  // never sends what they type next there.
  useEffect(() => {
    const focused = document.activeElement
    const inPane = focused?.closest(`[data-companion-of="${CSS.escape(terminal)}"]`) != null
    const lost = !focused || focused === document.body || inPane
    if (!open && wasOpen.current && lost)
      (
        trigger.current ??
        (inPane ? within.current?.querySelector<HTMLElement>("[data-terminal-input]") : null)
      )?.focus({ preventScroll: true })
    wasOpen.current = open
  }, [open, terminal])
  const paneView: PaneView = {
    member,
    leaving: !open,
    behind,
    itemStore,
    target,
    agent,
    messagesHandle,
    links,
    plans,
    originOf,
    onUndock: actions.undock,
    onMinimize: (each) => commands.minimizeOnBar(terminal, each.key),
    onHide: () => commands.closeBarPane(terminal),
    onClose: actions.close,
    onRaise: (each) => openPicked(each.key),
  }
  return (
    <div ref={within} className="terminal-companion">
      {shown.mounted && presentation === "split" ? (
        <SplitPane view={paneView} owner={terminal} terminalView={view} presence={shown}>
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
          className="taskbar taskbar-empty nodrag nopan"
          data-taskbar=""
          data-drop-target={overBar || undefined}
        >
          <span className="taskbar-empty-hint">Drop here to show it on this terminal</span>
        </div>
      )}
      <ConfirmDialog
        subject={closing}
        title={(item) => `Close “${item.name}”?`}
        description={() =>
          "Your edits to this plan couldn't be saved, and closing it loses them. Copy them first to keep them."
        }
        confirmLabel="Copy my edits and close"
        cancelLabel="Cancel"
        onCancel={() => setClosing(null)}
        onConfirm={() => {
          const item = closing
          setClosing(null)
          if (!item) return
          const plan = itemStore.store.getSnapshot().plans[item.id]
          if (plan)
            void navigator.clipboard
              ?.writeText(plan.eol === "\n" ? plan.text : plan.text.replaceAll("\n", plan.eol))
              .catch(() => undefined)
          commands.closeItem(item.id)
          // Closed from the pane with something behind it: the pane, still out, takes
          // focus, which the dialog would have put back on a button that's gone.
          if (item.id === showing && behind.length > 0)
            requestAnimationFrame(() => {
              const focused = document.activeElement
              if (focused && focused !== document.body) return
              document
                .querySelector<HTMLElement>(
                  `[data-companion-of="${CSS.escape(terminal)}"] .pane-reader`,
                )
                ?.focus({ preventScroll: true })
            })
        }}
        widthClassName="w-[min(360px,calc(100vw-32px))]"
      />
      {shown.mounted && presentation === "attached" && (
        <AttachedPane
          view={paneView}
          owner={terminal}
          within={within}
          onReveal={onReveal}
          presence={shown}
        />
      )}
    </div>
  )
}

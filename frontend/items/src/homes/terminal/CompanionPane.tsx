import { shellCounts } from "@novadeck/core/agents/shells"
import { kindRules } from "@novadeck/core/items"
import type { AgentShell, WorkspaceTarget } from "@novadeck/core/types"
import { Shown, useShown } from "@novadeck/toolkit/shown"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { createLucideIcon, Minus, X } from "lucide-react"
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { AwakeContext, useWakeful } from "../../awake"
import { isNew, isSecret, type BarMember, type BehindGroup } from "../../bar/bar"
import { onPaneAction } from "../../pane-actions"
import { usePanePicture, useStandInPicture, type PanePicture } from "../../pane-pictures"
import {
  PaneChrome,
  PaneTitle,
  TabFace,
  describeTab,
  noNote,
  tabTip,
  type TabLook,
  type TabNote,
} from "../../pane-row"
import { usePaneTurn } from "../../pane-turns"
import type { LookContext } from "../../registration"
import { registrationOf, stackNames } from "../../registry"
import type { ItemStore } from "../../store/item-store"
import { memberLook, MemberView, slotIcon } from "./drawing"
import type { MessagesHandle, MessageLinks } from "./messages/messages"

// Windows' restore glyph, drawn as lucide draws: a window lifting off the one it was
// maximized in, as an item docked in the pane lifts into a window of its own.
const Restore = createLucideIcon("restore", [
  ["rect", { x: "3", y: "8", width: "13", height: "13", rx: "2", key: "front" }],
  ["path", { d: "M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3", key: "back" }],
])

// What the pane does with what it shows, at the end of its row, as a window's title
// bar does on Windows: minimizes its icon's worth back to the taskbar, uncovering what's
// open behind it; undocks it into a window of its own, where it can; and closes it, off
// the taskbar, as the taskbar's menu does. Escape hides the whole pane, which is the same
// as minimizing while nothing's behind. Closing a pane closes all of its tabs.
const PaneActions = ({
  name,
  behind,
  onUndock,
  onMinimize,
  onClose,
}: {
  // What the pane shows, as closing it names it.
  name: string
  // Whether something's open behind it.
  behind: boolean
  onUndock: (() => void) | undefined
  onMinimize: () => void
  onClose: () => void
}): React.JSX.Element => (
  <span className="artifact-actions">
    <Tooltip content={behind ? "Minimize · Esc hides the pane" : "Minimize to the taskbar · Esc"}>
      <button
        type="button"
        className="icon-button"
        aria-label="Minimize to the taskbar"
        onClick={onMinimize}
      >
        <Minus size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
    {onUndock && (
      <Tooltip content="Undock to its own window">
        <button
          type="button"
          className="icon-button"
          aria-label="Undock to its own window"
          onClick={onUndock}
        >
          <Restore size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
    )}
    <Tooltip content={`Close ${name}`}>
      <button type="button" className="icon-button" aria-label={`Close ${name}`} onClick={onClose}>
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  </span>
)

// What the pane shows, on its sheet, which plays its entry once; awake while the person is
// at it (see ./awake), each of its own. While it waits its turn (see ../../pane-turns), what
// it shows isn't laid out, and its stand-in shows instead. `onElement` hears of the sheet,
// which its pictures are of (see ../../pane-pictures).
const Sheet = ({
  entry,
  waiting,
  onPlayed,
  onElement,
  children,
}: {
  entry: Entry | undefined
  waiting: boolean
  onPlayed: () => void
  onElement: (element: HTMLElement | null) => void
  children: ReactNode
}): React.JSX.Element => {
  const { awake, ref, on } = useWakeful()
  const own = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    onElement(own.current)
    return () => onElement(null)
  }, [onElement])
  return (
    <div
      className="pane-sheet"
      data-entry={entry}
      data-waiting={waiting || undefined}
      {...on}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onPlayed()
      }}
      // Cut short, as when its terminal is hidden mid-way: done all the same.
      ref={(element) => {
        ref(element)
        own.current = element
        const undo = whenCut(onPlayed)(element)
        return () => {
          ref(null)
          own.current = null
          undo?.()
        }
      }}
    >
      <AwakeContext value={awake}>{children}</AwakeContext>
    </div>
  )
}

// What stands in for what the pane shows until its turn: a picture of it as it was last
// drawn, where there is one taken at the size the pane is now, in the page's look now (see
// ../../pane-pictures), else its icon and name, as its tab has.
const StandIn = ({
  member,
  plans,
  picture,
}: {
  member: BarMember
  plans: LookContext["plans"]
  picture: () => PanePicture | undefined
}): React.JSX.Element => {
  const { icon: Icon, name } = memberLook(member, { plans })
  const element = useStandInPicture<HTMLDivElement>(picture)
  return (
    // A progress bar of no value, as something loading: no live region, which would speak
    // up for each pane a pan brings back.
    <div ref={element} className="pane-stand-in" role="progressbar" aria-label={`Opening ${name}`}>
      <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
      <span className="pane-stand-in-name">{name}</span>
    </div>
  )
}

// Calls `done` when an animation on the element itself is cut short, as by its terminal
// being hidden mid-way, which React has no prop for.
const whenCut =
  (done: () => void) =>
  (element: HTMLElement | null): (() => void) | undefined => {
    if (!element) return undefined
    const cut = (event: AnimationEvent): void => {
      if (event.target === element) done()
    }
    element.addEventListener("animationcancel", cut)
    return () => element.removeEventListener("animationcancel", cut)
  }

// How soon after the person acts in the pane what it shows must change for the pane to
// take focus: the change follows at once, so anything later wasn't theirs.
const handOffMs = 1000

// How many of the icons open behind the pane peek out above it: past that, the cards further
// back only thicken the stack's edge, and the taskbar still has them.
export const stackCap = 5

// The icons with something open behind the pane's, the nearest `stackCap`, peeking out above
// it as the cards of a file drawer do: each further back narrower and fainter, the nearest last. Each
// stays compact under the pointer and comes forward when clicked. One just shown tucks
// in behind what took its place, so the two read as swapped. Escape hides the pane from here
// too, as from what it shows, and Ctrl+PageDown and Ctrl+PageUp step through its tabs.
const BehindStack = ({
  behind,
  tucked,
  plans,
  onRaise,
  onTucked,
  onHide,
  onStepKey,
}: {
  // Nearest first.
  behind: readonly BehindGroup[]
  tucked: string | undefined
  plans: LookContext["plans"]
  onRaise: (member: BarMember) => void
  // The tuck played: it isn't played again, as when a hidden terminal shows again.
  onTucked: () => void
  onHide: () => void
  // Steps through the tabs of what the pane shows, as from anywhere in it.
  onStepKey: (event: React.KeyboardEvent) => void
}): React.JSX.Element => {
  const sheets = behind.slice(0, stackCap)
  return (
    <div
      className="pane-stack nodrag nopan"
      style={{ "--_count": sheets.length } as React.CSSProperties}
      data-workspace-companion
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          onHide()
        }
        onStepKey(event)
      }}
    >
      {sheets
        .map(({ slot, front }, depth) => {
          const { name } = memberLook(front, { plans })
          const Icon = slotIcon(slot)
          const names = slot.stack && stackNames(slot.stack)
          const count = slot.members.length
          return (
            <button
              key={slot.key}
              type="button"
              className="pane-stack-sheet"
              style={{ "--_depth": depth } as React.CSSProperties}
              data-entry={front.key === tucked ? "tuck" : undefined}
              data-state={slot.members.some(isNew) ? "new" : undefined}
              aria-label={
                names
                  ? `Bring forward ${count} ${names.one}s, ${name} in front`
                  : `Bring forward ${name}`
              }
              onClick={() => onRaise(front)}
              onAnimationEnd={onTucked}
              ref={whenCut(onTucked)}
            >
              <Icon size={12} strokeWidth={1.5} aria-hidden="true" />
              {names ? (
                <>
                  <b>{names.many}</b>
                  <span className="pane-stack-count">{count}</span>
                  <span className="pane-stack-name">· {name}</span>
                </>
              ) : (
                <b className="pane-stack-name">{name}</b>
              )}
            </button>
          )
        })
        .toReversed()}
    </div>
  )
}

// Where the pane's tab row was scrolled to, and which tab is to take focus: the row is
// drawn anew for each thing, and again as it loads, so the pane keeps them.
type TabRowMemory = {
  readonly scrolled: (scroll: number) => void
  // The person picked `key`, with focus in the row or not.
  readonly picked: (key: string, focused: boolean) => void
  readonly scroll: () => number
  // Whether the tab of `key` takes focus as its row is drawn: picked with focus in the
  // row a moment ago.
  readonly focuses: (key: string) => boolean
}

// The row of what the pane shows: the tabs of the icon it shows, each thing of it on the
// bar, the shown one selected; or, for one thing alone, its title in the same place, with no
// tab to pick, close or mark. A click shows a tab; the arrow keys, Home and End step along
// them as a tab list's do, showing each, but only move to one that may hold secrets, which
// Enter shows; Ctrl+PageDown and Ctrl+PageUp step from anywhere in the pane (see `stepTab`).
// Delete closes the tab with focus, as its × does under the pointer. The row scrolls
// sideways under the wheel too, keeping the shown tab, × and all, in view. The details of
// each tab are its tooltip, and its description.
const PaneTabs = ({
  tabs,
  shown,
  plans,
  memory,
  note,
  looks,
  onPick,
  onClose,
}: {
  tabs: readonly BarMember[]
  shown: string
  plans: LookContext["plans"]
  memory: TabRowMemory
  note: TabNote
  looks: (member: BarMember, note: TabNote) => TabLook
  onPick: (member: BarMember) => void
  onClose: (member: BarMember) => void
}): React.JSX.Element => {
  const row = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = row.current
    const tab = element?.querySelector<HTMLElement>(".pane-tab[data-state='open']")
    if (!element || !tab) return
    const place = (): void => {
      // Where the tab starts along the row, however far the row is scrolled now.
      const start =
        tab.getBoundingClientRect().left - element.getBoundingClientRect().left + element.scrollLeft
      // Past its end, the room the tools' fade takes over the row (scroll-padding in pane.css).
      const end =
        start +
        tab.offsetWidth +
        (parseFloat(getComputedStyle(element).scrollPaddingInlineEnd) || 0)
      element.scrollLeft = Math.min(
        Math.max(memory.scroll(), end - element.clientWidth),
        Math.max(0, start),
      )
    }
    place()
    // Again as the tab takes its width, as its font loads or what its viewer says of it
    // changes it, so it isn't left part under the fade.
    const sized = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place)
    sized?.observe(tab)
    if (memory.focuses(shown))
      tab.querySelector<HTMLElement>('[role="tab"]')?.focus({ preventScroll: true })
    return () => sized?.disconnect()
  }, [memory, shown])
  const pick = (tab: BarMember): void => {
    memory.picked(tab.key, row.current?.contains(document.activeElement) ?? false)
    onPick(tab)
  }
  if (tabs.length === 1) {
    const only = tabs[0]!
    const { icon, name } = memberLook(only, { plans })
    return (
      <PaneTitle icon={note.icon ?? icon} name={name} look={looks(only, note)} gone={note.gone} />
    )
  }
  return (
    <div
      ref={row}
      className="pane-tabs nodrag nopan"
      role="tablist"
      aria-label="Open in the pane"
      aria-keyshortcuts="Control+PageDown Control+PageUp"
      onScroll={(event) => {
        memory.scrolled(event.currentTarget.scrollLeft)
      }}
      onWheel={(event) => {
        if (event.deltaY !== 0 && event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY
      }}
      onKeyDown={(event) => {
        const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')]
        const at = buttons.indexOf(event.target as HTMLElement)
        if (at < 0) return
        if (event.key === "Delete") {
          event.preventDefault()
          return onClose(tabs[at]!)
        }
        const to = {
          ArrowLeft: (at - 1 + tabs.length) % tabs.length,
          ArrowRight: (at + 1) % tabs.length,
          Home: 0,
          End: tabs.length - 1,
        }[event.key]
        if (to === undefined) return
        event.preventDefault()
        const next = tabs[to]!
        if (isSecret(next) || next.key === shown) buttons[to]?.focus()
        else pick(next)
      }}
    >
      {tabs.map((tab) => {
        const { icon, name } = memberLook(tab, { plans })
        const open = tab.key === shown
        const look = looks(tab, open ? note : noNote)
        const gone = open && note.gone
        return (
          <span
            key={tab.key}
            className="pane-tab"
            data-state={open ? "open" : isNew(tab) ? "new" : undefined}
            data-failed={look.failed || undefined}
            data-gone={gone || undefined}
            data-placed={look.origin !== undefined || undefined}
          >
            <Tooltip content={look.tip.join("\n")} disabled={look.tip.length === 0}>
              <button
                type="button"
                role="tab"
                className="pane-tab-open"
                aria-selected={open}
                aria-keyshortcuts="Delete"
                aria-description={describeTab(look)}
                tabIndex={open ? 0 : -1}
                onClick={() => {
                  if (!open) pick(tab)
                }}
              >
                <TabFace icon={(open && note.icon) || icon} name={name} look={look} />
              </button>
            </Tooltip>
            {/* The pointer's close; the keyboard's is Delete on the tab, so the list holds
                only tabs. */}
            <span
              className="icon-button pane-tab-close"
              aria-hidden="true"
              title={`Close ${name}`}
              onClick={() => onClose(tab)}
            >
              <X size={12} strokeWidth={1.75} aria-hidden="true" />
            </span>
          </span>
        )
      })}
    </div>
  )
}

// The tab `by` along from the one shown, round the row's ends, as Ctrl+PageDown (1) and
// Ctrl+PageUp (-1) step from anywhere in the pane: never one that may hold secrets, which
// opens only when picked. Nothing, when there's no other tab to step to.
const stepTab = (tabs: readonly BarMember[], shown: string, by: 1 | -1): BarMember | undefined => {
  const at = tabs.findIndex((tab) => tab.key === shown)
  for (let step = 1; step < tabs.length; step++) {
    const tab = tabs[(at + by * step + tabs.length) % tabs.length]!
    if (!isSecret(tab)) return tab
  }
  return undefined
}

// How what the pane shows came to the top: forward from behind, or new over it. Nothing
// as the pane itself comes out, which animates on its own.
type Entry = "forward" | "arrive" | undefined

// What the pane last showed, and what was behind it, to tell how what it shows now came:
// `how` it came to the top, and what it `tucked` behind it, as what it showed before.
type LastShown = {
  readonly key: string | undefined
  readonly behind: string
  // The tabs it was one of.
  readonly tabs: string
  readonly how: Entry
  readonly tucked: string | undefined
}

// A terminal's companion pane, wherever it is presented: what it shows of the terminal's
// taskbar, `member`: a plan, edited where it's read, something an agent showed, its
// messages, or another terminal's item placed here, naming that terminal on its tab. It's
// the top of what's open in the pane, with in the row above it the tabs of everything of its
// icon (or its title, for one alone), its tools and the window's buttons; the other icons
// open wait behind it.
export const CompanionPane = ({
  member,
  leaving,
  tabs,
  behind,
  itemStore,
  target,
  agent,
  messagesHandle,
  links,
  plans,
  originOf,
  shells,
  onUndock,
  onMinimize,
  onHide,
  onClose,
  onClosePane,
  onRaise,
  first = false,
}: {
  member: BarMember | undefined
  // The pane is going: what it shows as it fades plays no entry of its own.
  leaving: boolean
  // Everything of its icon, as its tabs, while the icon is a stack.
  tabs: readonly BarMember[]
  // The icons open behind it, nearest first.
  behind: readonly BehindGroup[]
  itemStore: ItemStore
  target: WorkspaceTarget
  // Who showed what's here, as the pane's label names them.
  agent: string
  messagesHandle: MessagesHandle
  links: MessageLinks
  // The bar's plans, as the taskbar names them.
  plans: LookContext["plans"]
  originOf: (member: BarMember) => string | undefined
  // The background shells of the agents of the terminals the shells items are from, by
  // terminal id: a failed one marks its tab.
  shells?: Readonly<Record<string, readonly AgentShell[]>> | undefined
  // Undocks what's shown into a window of its own.
  onUndock: (member: BarMember) => void
  // Minimizes what's shown with the rest of its icon, uncovering what's behind; hides the
  // whole pane, as Escape does.
  onMinimize: (member: BarMember) => void
  onHide: () => void
  // Closes what's shown, as the taskbar's menu does, uncovering what's behind.
  onClose: (member: BarMember) => void
  // Closes every tab without selecting another tab in the group.
  onClosePane: () => void
  // Brings what's behind, or another tab, to the top.
  onRaise: (member: BarMember) => void
  // Its terminal is the selected one: its pane takes its turn ahead of the others.
  first?: boolean
}): React.JSX.Element => {
  // Its turn, each time it comes into sight; picking another tab while it's in sight
  // waits for none. Out of sight a while, what it shows goes, except a kind that stays
  // built (a page, a plan).
  const item = member?.kind === "item" ? member.item : undefined
  const turn = usePaneTurn(
    first,
    member !== undefined && !leaving,
    !item || !registrationOf(item).staysBuilt,
  )
  // While it isn't built, its item is followed all the same, so it shows at once when built
  // again rather than loading: what it held stays, only its view goes.
  const followed =
    item !== undefined && !turn.built && !leaving && kindRules[item.kind].follow !== "always"
      ? item.id
      : undefined
  useEffect(
    () => (followed === undefined ? undefined : itemStore.watch(target, followed)),
    [itemStore, target, followed],
  )
  // What it shows is shown once laid out: not while it stands in, as messages aren't
  // seen and a page doesn't wake behind the stand-in.
  const inSight = useShown()
  // A picture of what it shows, kept while it's laid out in sight, to stand in for it
  // while it waits its turn again; never of a kind drawn outside the page.
  const [sheet, setSheet] = useState<HTMLElement | null>(null)
  // Kept by this pane alone, for what it shows now: one remounting starts with none, and one
  // showing another tab lets the last one's go.
  const mount = useId()
  const picture = usePanePicture(
    sheet,
    inSight &&
      turn.built &&
      !turn.waiting &&
      !leaving &&
      !(item && registrationOf(item).drawnElsewhere),
    member && `${mount}:${member.key}`,
    undefined,
    true,
  )
  // A new top comes forward when it was behind, and over what was shown when it's new;
  // another tab of the same icon just shows.
  const behindKeys = behind.map((each) => each.front.key).join("\n")
  const tabKeys = tabs.map((each) => each.key).join("\n")
  const [entry, setEntry] = useState<LastShown>({
    key: member?.key,
    behind: behindKeys,
    tabs: tabKeys,
    how: undefined,
    tucked: undefined,
  })
  if (entry.key !== member?.key || entry.behind !== behindKeys || entry.tabs !== tabKeys) {
    const swapped =
      entry.key !== member?.key &&
      entry.key !== undefined &&
      member !== undefined &&
      !tabs.some((each) => each.key === entry.key) &&
      !entry.tabs.split("\n").includes(member.key)
    setEntry({
      key: member?.key,
      behind: behindKeys,
      tabs: tabKeys,
      how: !swapped
        ? entry.key === member?.key
          ? entry.how
          : undefined
        : entry.behind.split("\n").includes(member.key)
          ? "forward"
          : "arrive",
      tucked: !swapped
        ? entry.tucked
        : // Only onto a card drawn, whose tuck plays and clears it.
          behind.slice(0, stackCap).some((each) => each.front.key === entry.key)
          ? entry.key
          : undefined,
    })
  }
  // The entry played, or was cut short: it isn't played again.
  const played = (): void =>
    setEntry((current) => (current.how ? { ...current, how: undefined } : current))
  const messages = member?.kind === "messages"
  const plan = member?.kind === "item" && member.item.kind === "plan" ? member.item : undefined
  // Minimizing or closing what it showed, or bringing forward what's behind, from the pane
  // drops focus with what went: the pane takes it, as the window uncovered takes focus on
  // a desktop. Only then: a change the person didn't make here, as an agent's, takes no
  // focus, and focus the person has elsewhere stays there.
  const section = useRef<HTMLElement>(null)
  const shown = useRef(member?.key)
  const handedAt = useRef(-Infinity)
  const handOff =
    <Args extends unknown[]>(act: (...args: Args) => void) =>
    (...args: Args): void => {
      handedAt.current = performance.now()
      act(...args)
    }
  useEffect(() => {
    const before = shown.current
    shown.current = member?.key
    if (before === undefined || before === member?.key) return
    const handed = performance.now() - handedAt.current < handOffMs
    handedAt.current = -Infinity
    const focused = document.activeElement
    if (handed && (!focused || focused === document.body))
      section.current?.focus({ preventScroll: true })
  }, [member?.key])
  // Where the tab row was, for each row drawn: the pane's own, as long as it shows.
  const tabRow = useRef<{ scroll: number; focus: { key: string; at: number } | null }>({
    scroll: 0,
    focus: null,
  })
  const tabMemory = useMemo(
    (): TabRowMemory => ({
      scrolled: (scroll) => {
        tabRow.current.scroll = scroll
      },
      picked: (key, focused) => {
        tabRow.current.focus = focused ? { key, at: performance.now() } : null
      },
      scroll: () => tabRow.current.scroll,
      focuses: (key) => {
        const wanted = tabRow.current.focus
        return wanted?.key === key && performance.now() - wanted.at < handOffMs
      },
    }),
    [],
  )
  // Ctrl+PageDown and Ctrl+PageUp, from anywhere in the pane, show the next or previous tab,
  // focus following to it for the next step.
  const step = (by: 1 | -1): boolean => {
    const next = member && stepTab(tabs, member.key, by)
    if (!next) return false
    tabMemory.picked(next.key, true)
    onRaise(next)
    return true
  }
  const stepKey = (event: React.KeyboardEvent): void => {
    const by = { PageDown: 1, PageUp: -1 }[event.key] as 1 | -1 | undefined
    if (!by || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    if (!step(by)) return
    event.preventDefault()
    event.stopPropagation()
  }
  // The same, asked by a viewer whose keys the pane can't hear, as the PDF's frame.
  const actions = useRef({ onHide, step })
  useEffect(() => {
    actions.current = { onHide, step }
  })
  useEffect(() => {
    const element = section.current
    if (!element) return
    return onPaneAction(element, (action) => {
      if (action === "hide") actions.current.onHide()
      else actions.current.step(action === "next-tab" ? 1 : -1)
    })
  }, [])
  const undock = member?.kind === "item" && !member.placed ? () => onUndock(member) : undefined
  // What the row says of a tab: the item's own facts and, for the one shown, what its viewer
  // adds; the terminal a moved one came from; and a shell that failed.
  const looks = (each: BarMember, note: TabNote): TabLook => ({
    tip:
      each.kind === "item"
        ? tabTip(each.item, note.facts, { own: !each.placed, where: note.where })
        : [],
    origin:
      each.kind === "item" && each.placed ? (originOf(each) ?? "another terminal") : undefined,
    failed:
      each.kind === "item" &&
      each.item.kind === "shells" &&
      shellCounts(shells?.[each.item.from?.terminalId ?? ""]).failed > 0,
  })
  const tab = member && (
    <PaneChrome
      renderRow={(note) => (
        <PaneTabs
          tabs={tabs.length > 0 ? tabs : [member]}
          shown={member.key}
          plans={plans}
          memory={tabMemory}
          note={note}
          looks={looks}
          onPick={onRaise}
          onClose={handOff(onClose)}
        />
      )}
      end={
        <PaneActions
          name={tabs.length > 1 ? "all tabs" : memberLook(member, { plans }).name}
          behind={behind.length > 0}
          onUndock={undock}
          onMinimize={handOff(() => onMinimize(member))}
          onClose={handOff(onClosePane)}
        />
      }
    >
      <MemberView
        key={member.key}
        member={member}
        itemStore={itemStore}
        target={target}
        messagesHandle={messagesHandle}
        links={links}
      />
    </PaneChrome>
  )
  return (
    <>
      {/* There while nothing's behind too: the split keeps what it shows clear of the
          window's header. */}
      <BehindStack
        behind={behind}
        tucked={entry.tucked}
        plans={plans}
        onRaise={handOff(onRaise)}
        onTucked={() =>
          setEntry((current) => (current.tucked ? { ...current, tucked: undefined } : current))
        }
        onHide={onHide}
        onStepKey={stepKey}
      />
      <section
        ref={section}
        tabIndex={-1}
        className="pane-reader"
        data-workspace-companion
        data-tour="side-pane"
        aria-label={messages ? "Messages" : `What ${agent} showed you`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation()
            onHide()
          }
          stepKey(event)
        }}
        // Leaving the plan saves it at once, so an agent told to re-read it finds the edits.
        onBlur={(event) => {
          if (plan && !event.currentTarget.contains(event.relatedTarget))
            itemStore.plan(target, plan.id).flush()
        }}
      >
        {!member ? (
          // All that's left may hold secrets, which shows only once picked; or, as the
          // pane goes, what it showed is gone.
          leaving ? null : (
            <div className="artifact-status">Pick what to show from the taskbar.</div>
          )
        ) : (
          // Played once: a hidden terminal shown again doesn't play it again.
          <Sheet
            key={member.key}
            entry={leaving ? undefined : entry.how}
            waiting={turn.waiting}
            onPlayed={played}
            onElement={setSheet}
          >
            {turn.built && <Shown value={inSight && !turn.waiting}>{tab}</Shown>}
            {turn.waiting && <StandIn member={member} plans={plans} picture={picture} />}
          </Sheet>
        )}
      </section>
    </>
  )
}

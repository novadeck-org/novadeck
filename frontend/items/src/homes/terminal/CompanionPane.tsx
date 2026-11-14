import type { WorkspaceTarget } from "@novadeck/core/types"
import { Shown, useShown } from "@novadeck/toolkit/shown"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { createLucideIcon, Minus, X } from "lucide-react"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { AwakeContext, useWakeful } from "../../awake"
import { isNew, isSecret, type BarMember, type BehindGroup } from "../../bar/bar"
import { usePaneTurn } from "../../pane-turns"
import type { LookContext } from "../../registration"
import { stackNames } from "../../registry"
import type { ItemStore } from "../../store/item-store"
import { UnderHeader } from "../../under-header"
import { memberLook, MemberView, slotIcon } from "./drawing"
import type { MessagesHandle, MessageLinks } from "./messages/messages"

// Windows' restore glyph, drawn as lucide draws: a window lifting off the one it was
// maximized in, as an item docked in the pane lifts into a window of its own.
const Restore = createLucideIcon("restore", [
  ["rect", { x: "3", y: "8", width: "13", height: "13", rx: "2", key: "front" }],
  ["path", { d: "M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3", key: "back" }],
])

// What the pane does with what it shows, at the end of its header, as a window's title
// bar does on Windows: minimizes its icon's worth back to the taskbar, uncovering what's
// open behind it; undocks it into a window of its own, where it can; and closes it, off
// the taskbar, as the taskbar's menu does. Escape hides the whole pane, which is the same
// as minimizing while nothing's behind. Under tabs, closing is each tab's own.
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
  onClose: (() => void) | undefined
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
    {onClose && (
      <Tooltip content="Close">
        <button
          type="button"
          className="icon-button"
          aria-label={`Close ${name}`}
          onClick={onClose}
        >
          <X size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </Tooltip>
    )}
  </span>
)

// What the pane shows, on its sheet, which plays its entry once; awake while the person is
// at it (see ./awake), each of its own. While it waits its turn (see ../../pane-turns), what
// it shows isn't laid out, and its stand-in shows instead.
const Sheet = ({
  entry,
  waiting,
  onPlayed,
  children,
}: {
  entry: Entry | undefined
  waiting: boolean
  onPlayed: () => void
  children: ReactNode
}): React.JSX.Element => {
  const { awake, ref, on } = useWakeful()
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
        const undo = whenCut(onPlayed)(element)
        return () => {
          ref(null)
          undo?.()
        }
      }}
    >
      <AwakeContext value={awake}>{children}</AwakeContext>
    </div>
  )
}

// What stands in for what the pane shows until its turn: its icon and name, as its tab has.
const StandIn = ({
  member,
  plans,
}: {
  member: BarMember
  plans: LookContext["plans"]
}): React.JSX.Element => {
  const { icon: Icon, name } = memberLook(member, { plans })
  return (
    // A progress bar of no value, as something loading: no live region, which would speak
    // up for each pane a pan brings back.
    <div className="pane-stand-in" role="progressbar" aria-label={`Opening ${name}`}>
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

// The icons with something open behind the pane's, every one, peeking out above it as the
// cards of a file drawer do: each further back narrower and fainter, the nearest last. Each
// lifts under the pointer to say what it holds (a thing's name, or a stack's kind, count and
// the one in front) and comes forward when clicked. One that was just shown tucks in
// behind what took its place, so the two read as swapped. Escape hides the pane from here
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
}): React.JSX.Element => (
  <div
    className="pane-stack nodrag nopan"
    style={{ "--_count": behind.length } as React.CSSProperties}
    data-workspace-companion
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onHide()
      }
      onStepKey(event)
    }}
  >
    {behind
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

// Where the pane's tab row was scrolled to, and which tab is to take focus: the row is
// drawn anew under each thing's header, and again as it loads, so the pane keeps them.
type TabRowMemory = {
  readonly scrolled: (scroll: number) => void
  // The person picked `key`, with focus in the row or not.
  readonly picked: (key: string, focused: boolean) => void
  readonly scroll: () => number
  // Whether the tab of `key` takes focus as its row is drawn: picked with focus in the
  // row a moment ago.
  readonly focuses: (key: string) => boolean
}

// The tabs of the icon the pane shows, under its header: each thing of it on the bar, the
// shown one selected. A click shows one; the arrow keys, Home and End step along them as a
// tab list's do, showing each, but only move to one that may hold secrets, which Enter
// shows; Ctrl+PageDown and Ctrl+PageUp step from anywhere in the pane (see `stepTab`).
// Delete closes the tab with focus, as its × does under the pointer. The row scrolls
// sideways under the wheel too, keeping the shown tab, × and all, in view.
const PaneTabs = ({
  tabs,
  shown,
  plans,
  memory,
  onPick,
  onClose,
}: {
  tabs: readonly BarMember[]
  shown: string
  plans: LookContext["plans"]
  memory: TabRowMemory
  onPick: (member: BarMember) => void
  onClose: (member: BarMember) => void
}): React.JSX.Element => {
  const row = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = row.current
    const tab = element?.querySelector<HTMLElement>(".pane-tab[data-state='open']")
    if (!element || !tab) return
    // Where the tab starts along the row, however far the row is scrolled now.
    const start =
      tab.getBoundingClientRect().left - element.getBoundingClientRect().left + element.scrollLeft
    const end = start + tab.offsetWidth
    element.scrollLeft = Math.min(
      Math.max(memory.scroll(), end - element.clientWidth),
      Math.max(0, start),
    )
    if (memory.focuses(shown))
      tab.querySelector<HTMLElement>('[role="tab"]')?.focus({ preventScroll: true })
  }, [memory, shown])
  const pick = (tab: BarMember): void => {
    memory.picked(tab.key, row.current?.contains(document.activeElement) ?? false)
    onPick(tab)
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
        const { icon: Icon, name } = memberLook(tab, { plans })
        const open = tab.key === shown
        return (
          <span
            key={tab.key}
            className="pane-tab"
            data-state={open ? "open" : isNew(tab) ? "new" : undefined}
          >
            <button
              type="button"
              role="tab"
              className="pane-tab-open"
              aria-selected={open}
              aria-keyshortcuts="Delete"
              tabIndex={open ? 0 : -1}
              title={name}
              onClick={() => {
                if (!open) pick(tab)
              }}
            >
              <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
              <span className="pane-tab-name">{name}</span>
            </button>
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
// messages, or another terminal's item placed here, under a line saying whose it is. It's
// the top of what's open in the pane, under its header the tabs of everything of its
// icon; the other icons open wait behind it.
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
  onUndock,
  onMinimize,
  onHide,
  onClose,
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
  // Undocks what's shown into a window of its own.
  onUndock: (member: BarMember) => void
  // Minimizes what's shown with the rest of its icon, uncovering what's behind; hides the
  // whole pane, as Escape does.
  onMinimize: (member: BarMember) => void
  onHide: () => void
  // Closes what's shown, as the taskbar's menu does, uncovering what's behind.
  onClose: (member: BarMember) => void
  // Brings what's behind, or another tab, to the top.
  onRaise: (member: BarMember) => void
  // Its terminal is the selected one: its pane takes its turn ahead of the others.
  first?: boolean
}): React.JSX.Element => {
  // Its turn, each time it comes into sight; picking another tab while it's in sight
  // waits for none.
  const turn = usePaneTurn(first, member !== undefined && !leaving)
  // What it shows is shown once laid out: not while it stands in, as messages aren't
  // seen and a page doesn't wake behind the stand-in.
  const inSight = useShown()
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
        : behind.some((each) => each.front.key === entry.key)
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
  const stepKey = (event: React.KeyboardEvent): void => {
    const by = { PageDown: 1, PageUp: -1 }[event.key] as 1 | -1 | undefined
    if (!by || !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    const next = member && stepTab(tabs, member.key, by)
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    tabMemory.picked(next.key, true)
    onRaise(next)
  }
  const undock = member?.kind === "item" && !member.placed ? () => onUndock(member) : undefined
  const tab = member && (
    <UnderHeader
      value={
        tabs.length > 1 ? (
          <PaneTabs
            tabs={tabs}
            shown={member.key}
            plans={plans}
            memory={tabMemory}
            onPick={onRaise}
            onClose={handOff(onClose)}
          />
        ) : null
      }
    >
      <MemberView
        key={member.key}
        member={member}
        itemStore={itemStore}
        target={target}
        messagesHandle={messagesHandle}
        links={links}
        actions={
          <PaneActions
            name={memberLook(member, { plans }).name}
            behind={behind.length > 0}
            onUndock={undock}
            onMinimize={handOff(() => onMinimize(member))}
            onClose={tabs.length > 1 ? undefined : handOff(() => onClose(member))}
          />
        }
      />
    </UnderHeader>
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
          >
            {turn.built && (
              <Shown value={inSight && !turn.waiting}>
                {member.kind === "item" && member.placed ? (
                  <div className="placed-tab">
                    <p className="placed-from">From {originOf(member) ?? "another terminal"}</p>
                    {tab}
                  </div>
                ) : (
                  tab
                )}
              </Shown>
            )}
            {turn.waiting && <StandIn member={member} plans={plans} />}
          </Sheet>
        )}
      </section>
    </>
  )
}

import type { WorkspaceTarget } from "@novadeck/core/types"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { createLucideIcon, Minus, X } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { AwakeContext, useWakeful } from "../../awake"
import type { BarMember } from "../../bar"
import type { LookContext } from "../../registration"
import type { ItemStore } from "../../state"
import { memberLook, MemberView } from "./drawing"
import type { MailHandle } from "./messages/mail"
import type { PlanPresentation } from "./presentation"

// Windows' restore glyph, drawn as lucide draws: a window lifting off the one it was
// maximized in, as an item docked in the pane lifts into a window of its own.
const Restore = createLucideIcon("restore", [
  ["rect", { x: "3", y: "8", width: "13", height: "13", rx: "2", key: "front" }],
  ["path", { d: "M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3", key: "back" }],
])

// What the pane does with what it shows, at the end of its header, as a window's title
// bar does on Windows: minimizes it back to the taskbar, uncovering what's open behind
// it; undocks it into a window of its own, where it can; and closes it, off the taskbar,
// as the taskbar's menu does. Escape hides the whole pane, which is the same as
// minimizing while nothing's behind.
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
    <Tooltip content="Close">
      <button type="button" className="icon-button" aria-label={`Close ${name}`} onClick={onClose}>
        <X size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  </span>
)

// How many of what's behind peek out above what the pane shows.
const peeking = 2

// What the pane shows, on its sheet, which plays its entry once; awake while the person is
// at it (see ./awake), each of its own.
const Sheet = ({
  entry,
  onPlayed,
  children,
}: {
  entry: Entry | undefined
  onPlayed: () => void
  children: ReactNode
}): React.JSX.Element => {
  const { awake, ref, on } = useWakeful()
  return (
    <div
      className="plan-sheet"
      data-entry={entry}
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

// The sheets open behind what the pane shows, peeking out above it as cards stacked
// behind one another do: each further back narrower and fainter, the nearest last. Each
// names itself on hover and comes forward when clicked. One that was just shown tucks in
// behind what took its place, so the two read as swapped. Escape hides the pane from
// here too, as from what it shows.
const BehindStack = ({
  behind,
  tucked,
  plans,
  onRaise,
  onTucked,
  onHide,
}: {
  // Nearest first.
  behind: readonly BarMember[]
  tucked: string | undefined
  plans: LookContext["plans"]
  onRaise: (member: BarMember) => void
  // The tuck played: it isn't played again, as when a hidden terminal shows again.
  onTucked: () => void
  onHide: () => void
}): React.JSX.Element => (
  <div
    className="plan-stack nodrag nopan"
    data-workspace-companion
    onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onHide()
      }
    }}
  >
    {behind
      .slice(0, peeking)
      .toReversed()
      .map((each) => {
        const { name } = memberLook(each, { plans })
        return (
          <Tooltip key={each.key} content={name}>
            <button
              type="button"
              className="plan-stack-sheet"
              data-entry={each.key === tucked ? "tuck" : undefined}
              aria-label={`Bring forward ${name}`}
              onClick={() => onRaise(each)}
              onAnimationEnd={onTucked}
              ref={whenCut(onTucked)}
            />
          </Tooltip>
        )
      })}
  </div>
)

// How what the pane shows came to the top: forward from behind, or new over it. Nothing
// as the pane itself comes out, which animates on its own.
type Entry = "forward" | "arrive" | undefined

// What the pane last showed, and what was behind it, to tell how what it shows now came:
// `how` it came to the top, and what it `tucked` behind it, as what it showed before.
type Shown = {
  readonly key: string | undefined
  readonly behind: string
  readonly how: Entry
  readonly tucked: string | undefined
}

// A terminal's companion pane, wherever it is presented: what it shows of the terminal's
// taskbar, `member`: a plan, edited where it's read, something an agent showed, its
// messages, or another terminal's item placed here, under a line saying whose it is. It's
// the top of what's open in the pane; the rest waits behind it.
export const CompanionPane = ({
  member,
  leaving,
  behind,
  itemStore,
  target,
  agent,
  mail,
  peerName,
  presentation,
  plans,
  originOf,
  onUndock,
  onMinimize,
  onHide,
  onClose,
  onRaise,
}: {
  member: BarMember | undefined
  // The pane is going: what it shows as it fades plays no entry of its own.
  leaving: boolean
  // What's open behind it, nearest first.
  behind: readonly BarMember[]
  itemStore: ItemStore
  target: WorkspaceTarget
  // Who showed what's here, as the pane's label names them.
  agent: string
  mail: MailHandle
  peerName: (handle: string) => string | undefined
  presentation: PlanPresentation
  // The bar's plans, as the taskbar names them.
  plans: LookContext["plans"]
  originOf: (member: BarMember) => string | undefined
  // Undocks what's shown into a window of its own.
  onUndock: (member: BarMember) => void
  // Minimizes what's shown, uncovering what's behind; hides the whole pane, as Escape does.
  onMinimize: (member: BarMember) => void
  onHide: () => void
  // Closes what's shown, as the taskbar's menu does, uncovering what's behind.
  onClose: (member: BarMember) => void
  // Brings what's behind to the top.
  onRaise: (member: BarMember) => void
}): React.JSX.Element => {
  // A new top comes forward when it was behind, and over what was shown when it's new.
  const behindKeys = behind.map((each) => each.key).join("\n")
  const [entry, setEntry] = useState<Shown>({
    key: member?.key,
    behind: behindKeys,
    how: undefined,
    tucked: undefined,
  })
  if (entry.key !== member?.key || entry.behind !== behindKeys) {
    const swapped = entry.key !== member?.key && entry.key !== undefined && member !== undefined
    setEntry({
      key: member?.key,
      behind: behindKeys,
      how: !swapped
        ? entry.key === member?.key
          ? entry.how
          : undefined
        : entry.behind.split("\n").includes(member.key)
          ? "forward"
          : "arrive",
      tucked: !swapped
        ? entry.tucked
        : behind.some((each) => each.key === entry.key)
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
  const undock = member?.kind === "item" && !member.placed ? () => onUndock(member) : undefined
  const tab = member && (
    <MemberView
      key={member.key}
      member={member}
      itemStore={itemStore}
      target={target}
      mail={mail}
      peerName={peerName}
      actions={
        <PaneActions
          name={memberLook(member, { plans }).name}
          behind={behind.length > 0}
          onUndock={undock}
          onMinimize={handOff(() => onMinimize(member))}
          onClose={handOff(() => onClose(member))}
        />
      }
    />
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
      />
      <section
        ref={section}
        tabIndex={-1}
        className="plan-reader"
        data-workspace-companion
        data-presentation={presentation}
        aria-label={messages ? "Messages" : `What ${agent} showed you`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation()
            onHide()
          }
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
          <Sheet key={member.key} entry={leaving ? undefined : entry.how} onPlayed={played}>
            {member.kind === "item" && member.placed ? (
              <div className="placed-tab">
                <p className="placed-from">From {originOf(member) ?? "another terminal"}</p>
                {tab}
              </div>
            ) : (
              tab
            )}
          </Sheet>
        )}
      </section>
    </>
  )
}

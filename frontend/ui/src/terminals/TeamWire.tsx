import type { Team } from "@novadeck/core/derivations"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import {
  blinkMs,
  foldGhost,
  foldGutter,
  wireShape,
  type FoldGutter,
  type WireMember,
  type WireShape,
} from "./team-wire"

// How long the wire keeps measuring after something that moves the tabs without a layout
// change it can observe: a drop's settle (180ms) and the sidebar's first frames once shown.
const settleMs = 400

const sameWires = (a: Wires, b: Wires) => JSON.stringify(a) === JSON.stringify(b)

// Whether a tab is laid out: a teammate folded out of the list (team-fold.ts) isn't.
const laidOut = (tab: Element) => tab.getClientRects().length > 0

// Where a tab's name line sits, and its left edge, in the wire layer's frame. While the tab is
// renamed its name gives way to a field, so the line is taken from the tab's top.
const memberOf = (tab: Element, id: string, origin: DOMRect): WireMember => {
  const rect = tab.getBoundingClientRect()
  const name = tab.querySelector(".sidebar-item-copy strong")?.getBoundingClientRect()
  const y = name ? name.top + name.height / 2 : rect.top + 19
  return { id, y: y - origin.top, left: rect.left - origin.left }
}

// A team's wire as measured: its shape, the gutter beside its lead's tab where pointing arms
// its fold, and while it's folded, where its tabs would land as it unfolds.
type Measured = {
  readonly shape: WireShape
  readonly gutter: FoldGutter | undefined
  readonly ghost: readonly number[]
}

// Measures the wire for `team` against the page as it is now: none while the rail isn't
// laid out (as on a phone) or the lead's tab is missing. A folded team's workers' tabs aren't
// laid out, and its wire is its lead's cursor alone.
const measureWire = (
  layer: HTMLElement,
  list: Element,
  team: Team,
  folded: boolean,
): Measured | undefined => {
  const rail = layer.parentElement?.querySelector(":scope > .sidebar-tools")
  if (!rail) return undefined
  const origin = layer.getBoundingClientRect()
  const railRect = rail.getBoundingClientRect()
  const listRect = list.getBoundingClientRect()
  const tab = (id: string) => list.querySelector(`[data-terminal-tab-id="${CSS.escape(id)}"]`)
  const leadTab = tab(team.lead)
  const workers = team.workers.flatMap((id) => {
    const each = tab(id)
    return each && laidOut(each) ? [memberOf(each, id, origin)] : []
  })
  if (!leadTab || !laidOut(leadTab) || !railRect.width) return undefined
  const x = railRect.right - origin.left - 1
  const view = { top: listRect.top - origin.top, bottom: listRect.bottom - origin.top }
  const shape = wireShape(x, view, memberOf(leadTab, team.lead, origin), workers)
  if (!shape) return undefined
  const leadRect = leadTab.getBoundingClientRect()
  const gutter = foldGutter(x, view, {
    top: leadRect.top - origin.top,
    height: leadRect.height,
    left: leadRect.left - origin.left,
  })
  const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 0
  const ghost =
    folded && !workers.length && shape.lead !== undefined
      ? foldGhost(shape.lead, leadRect.height + gap, team.workers.length, view)
      : []
  return { shape, gutter, ghost }
}

// Every team's wire, by its lead, in the teams' order.
type Wires = readonly ({ readonly lead: string } & Measured)[]

const measureWires = (
  layer: HTMLElement,
  list: Element,
  teams: readonly Team[],
  folded: readonly string[],
): Wires =>
  teams.flatMap((team) => {
    const measured = measureWire(layer, list, team, folded.includes(team.lead))
    return measured ? [{ lead: team.lead, ...measured }] : []
  })

// Every team's wire on the rail's border, while the Terminals list shows: the border between
// the rail and the sidebar is drawn from each team's topmost tab to its bottommost, a block
// cursor marks the lead, and a tick runs from the wire into each worker's tab. Every wire
// rests, dim, so who leads whom shows without selecting anything; the selected terminal's
// team lights, and plays its entrance each time one of its members is selected: the segment
// grows, the ticks reach out and the cursor blinks. It sits over the workspace body, beside
// the rail and the sidebar, as the sidebar clips what's drawn outside it; it takes no
// pointer and is only drawn, as the window's header says who leads a terminal in words, but
// for the gutter beside each lead's tab, which folds its teammates out of the list (or shows
// them again) for a person who only follows the lead. Pointing there shows what a click does,
// with no words: the wire reels into the lead's cursor as its teammates' tabs dim, or, folded,
// a dashed ghost of it runs down to where the tabs would land. The pointer has to come to the
// gutter on purpose: nothing over the tab itself arms it, and after a click it arms again only
// once the pointer has left. The lead's menu is the keyboard's way to the same fold.
export const TeamWire = ({
  teams,
  team,
  selected,
  shown,
  list,
  folded = noLeads,
  onFold,
  onPreview,
}: {
  teams: readonly Team[]
  // The selected terminal's team, which lights.
  team: Team | undefined
  // The selected terminal: selecting another member plays the lit wire's entrance again.
  selected: string
  // Whether the Terminals list is on screen.
  shown: boolean
  // The Terminals list's element, a new one in each session and in each of the drawer and
  // the side pane.
  list: HTMLElement | null
  // The leads whose teams the person folded out of the list.
  folded?: readonly string[]
  // Folds a lead's team, or shows it again; without it, no gutter takes the pointer.
  onFold?: ((lead: string) => void) | undefined
  // Says which lead's gutter the person points at, so its teammates' tabs show what a click
  // does, or that they point at none. Kept the same from render to render: a new one ends the
  // preview the last one set.
  onPreview?: ((lead: string | null) => void) | undefined
}): React.JSX.Element => {
  const layer = useRef<HTMLDivElement>(null)
  const [wires, setWires] = useState<Wires>([])
  // The selection whose entrance has played. Any change of selection forgets it, so coming
  // back to a member before the timer below fires plays the entrance again.
  const [played, setPlayed] = useState<string | undefined>(undefined)
  // The lead whose gutter the person points at, and whether they clicked there since they
  // came, which holds it until they leave.
  const [armed, setArmed] = useState<string | undefined>(undefined)
  const spent = useRef<string | undefined>(undefined)
  const [seen, setSeen] = useState(selected)
  if (seen !== selected) {
    setSeen(selected)
    setPlayed(undefined)
  }

  // Everything that keeps the wires on the tabs while the list shows: one run owns its
  // observers, listeners and frame loop, and its cleanup ends them all, so a change of teams
  // or of the list's visibility never leaves an earlier run measuring.
  useLayoutEffect(() => {
    const element = layer.current
    const body = element?.parentElement
    if (!element || !body || !list || !teams.length || !shown) return
    const measure = () => {
      const next = measureWires(element, list, teams, folded)
      setWires((current) => (sameWires(current, next) ? current : next))
    }
    // Measures every frame until `until`, through moves no observer reports: a drag, its
    // drop and the sidebar being shown.
    let frame = 0
    let until = 0
    const follow = (ms: number) => {
      until = Math.max(until, performance.now() + ms)
      if (frame) return
      const step = () => {
        measure()
        frame = performance.now() < until ? requestAnimationFrame(step) : 0
      }
      frame = requestAnimationFrame(step)
    }
    // Tabs that change size, and tabs added, closed or moved, which the list's children say.
    const resized = new ResizeObserver(() => measure())
    const watch = () => {
      resized.disconnect()
      resized.observe(body)
      resized.observe(list)
      for (const tab of list.querySelectorAll("[data-terminal-tab-id]")) resized.observe(tab)
    }
    const changed = new MutationObserver(() => {
      watch()
      measure()
    })
    // A press on the list may start a drag, which moves the tabs by transforms: follow them
    // until it's let go, wherever that happens. The drag library stops the release on the
    // document once a drag began, so the window hears it first, as it is captured.
    let dragging = false
    const keep = () => {
      if (!dragging) return
      follow(settleMs)
      requestAnimationFrame(keep)
    }
    const drag = () => {
      if (dragging) return
      dragging = true
      keep()
    }
    const drop = () => {
      dragging = false
      follow(settleMs)
    }
    const key = () => follow(settleMs)
    measure()
    follow(settleMs)
    watch()
    changed.observe(list, { childList: true })
    list.addEventListener("scroll", measure, { passive: true })
    list.addEventListener("pointerdown", drag)
    list.addEventListener("keydown", key)
    window.addEventListener("pointerup", drop, { capture: true })
    window.addEventListener("pointercancel", drop, { capture: true })
    window.addEventListener("blur", drop)
    return () => {
      dragging = false
      cancelAnimationFrame(frame)
      resized.disconnect()
      changed.disconnect()
      list.removeEventListener("scroll", measure)
      list.removeEventListener("pointerdown", drag)
      list.removeEventListener("keydown", key)
      window.removeEventListener("pointerup", drop, { capture: true })
      window.removeEventListener("pointercancel", drop, { capture: true })
      window.removeEventListener("blur", drop)
    }
  }, [teams, shown, list, folded])

  // The entrance plays once each time a member is selected; redraws after it, as rows scroll
  // into view, put the wire in place without playing it again.
  useEffect(() => {
    const timer = setTimeout(() => setPlayed(selected), blinkMs + 200)
    return () => clearTimeout(timer)
  }, [selected])

  // What the last run measured counts only while teams show in a list. The lit wire is drawn
  // last, over any resting one it crosses.
  const drawn = teams.length && shown && list ? wires : []
  const lit = drawn.find((wire) => wire.lead === team?.lead)
  // A gutter that goes away under the pointer, as the sidebar hides, the session changes or the
  // team ends, hears no leave: what pointing there armed ends with it (here, as the selection's
  // entrance is forgotten above), the preview it set ends as it does (below), and a click there
  // no longer holds the next arming back.
  const gutters = drawn.flatMap(({ lead, gutter }) => (gutter ? [lead] : [])).join(" ")
  if (armed !== undefined && !gutters.split(" ").includes(armed)) setArmed(undefined)
  useEffect(() => {
    if (spent.current !== undefined && !gutters.split(" ").includes(spent.current))
      spent.current = undefined
  }, [gutters])
  // The preview lasts as long as the arming, however that ends, the wires' going included.
  useEffect(() => {
    if (armed === undefined) return
    return () => onPreview?.(null)
  }, [armed, onPreview])
  return (
    <div
      ref={layer}
      className="team-wire"
      aria-hidden
      data-settled={played === selected || undefined}
    >
      {drawn.map(
        (wire) =>
          wire !== lit && (
            <Wire
              key={wire.lead}
              wire={wire}
              lit={false}
              folded={folded.includes(wire.lead)}
              armed={armed === wire.lead}
            />
          ),
      )}
      {lit && (
        <Wire
          key={`${lit.lead}:${selected}`}
          wire={lit}
          lit
          folded={folded.includes(lit.lead)}
          armed={armed === lit.lead}
        />
      )}
      {onFold &&
        drawn.map(
          ({ lead, gutter }) =>
            gutter && (
              <span
                key={`gutter:${lead}`}
                className="team-wire-gutter"
                data-team-wire-gutter={lead}
                style={{
                  left: gutter.left,
                  top: gutter.top,
                  width: gutter.width,
                  height: gutter.height,
                }}
                onPointerEnter={() => {
                  if (spent.current === lead) return
                  setArmed(lead)
                  onPreview?.(lead)
                }}
                onPointerLeave={() => {
                  spent.current = undefined
                  setArmed(undefined)
                }}
                onClick={() => {
                  spent.current = lead
                  setArmed(undefined)
                  onFold(lead)
                }}
                // The gutter lies over the list's edge: a wheel there scrolls the list.
                onWheel={(event) => list?.scrollBy({ top: event.deltaY })}
              />
            ),
        )}
    </div>
  )
}
const noLeads: readonly string[] = []

const Wire = ({
  wire: { shape, ghost },
  lit,
  folded,
  armed,
}: {
  wire: Measured
  lit: boolean
  folded: boolean
  armed: boolean
}): React.JSX.Element => (
  <div
    className="team-wire-shape"
    data-lit={lit || undefined}
    data-folded={folded || undefined}
    data-armed={armed || undefined}
  >
    <i
      className="team-wire-segment"
      style={{ left: shape.x, top: shape.top, height: shape.height }}
    />
    {shape.taps.map((tap) => (
      <i
        key={tap.id}
        className="team-wire-tap"
        style={{ left: shape.x, top: tap.y, width: tap.width }}
      />
    ))}
    {shape.lead !== undefined && ghost.length > 0 && (
      <>
        <i
          className="team-wire-ghost"
          style={{ left: shape.x, top: shape.lead, height: ghost.at(-1)! - shape.lead + 1 }}
        />
        {ghost.map((y, index) => (
          <i
            key={y}
            className="team-wire-ghost-tap"
            style={{ left: shape.x, top: y, transitionDelay: `${180 + index * 90}ms` }}
          />
        ))}
      </>
    )}
    {shape.lead !== undefined && (
      <i className="team-wire-cursor" style={{ left: shape.x, top: shape.lead }} />
    )}
  </div>
)

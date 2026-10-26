import type { Team } from "@novadeck/core/derivations"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { blinkMs, wireShape, type WireMember, type WireShape } from "./team-wire"

// How long the wire keeps measuring after something that moves the tabs without a layout
// change it can observe: a drop's settle (180ms) and the sidebar's first frames once shown.
const settleMs = 400

const sameWires = (a: Wires, b: Wires) => JSON.stringify(a) === JSON.stringify(b)

// Where a tab's name line sits, and its left edge, in the host's frame. While the tab is
// renamed its name gives way to a field, so the line is taken from the tab's top.
const memberOf = (tab: Element, id: string, origin: DOMRect): WireMember => {
  const rect = tab.getBoundingClientRect()
  const name = tab.querySelector(".sidebar-item-copy strong")?.getBoundingClientRect()
  const y = name ? name.top + name.height / 2 : rect.top + 19
  return { id, y: y - origin.top, left: rect.left - origin.left }
}

// Measures the wire for `team` against the page as it is now: none while the rail isn't
// laid out (as on a phone), the lead's tab is missing, or no worker's tab is.
const measureWire = (host: HTMLElement, list: Element, team: Team): WireShape | undefined => {
  const rail = host.parentElement?.querySelector(":scope > .sidebar-tools")
  if (!rail) return undefined
  const origin = host.getBoundingClientRect()
  const railRect = rail.getBoundingClientRect()
  const listRect = list.getBoundingClientRect()
  const tab = (id: string) => list.querySelector(`[data-terminal-tab-id="${CSS.escape(id)}"]`)
  const leadTab = tab(team.lead)
  const workers = team.workers.flatMap((id) => {
    const each = tab(id)
    return each ? [memberOf(each, id, origin)] : []
  })
  if (!leadTab || !workers.length || !railRect.width) return undefined
  return wireShape(
    railRect.right - origin.left - 1,
    { top: listRect.top - origin.top, bottom: listRect.bottom - origin.top },
    memberOf(leadTab, team.lead, origin),
    workers,
  )
}

// Every team's wire, by its lead, in the teams' order.
type Wires = readonly { readonly lead: string; readonly shape: WireShape }[]

const measureWires = (host: HTMLElement, list: Element, teams: readonly Team[]): Wires =>
  teams.flatMap((team) => {
    const shape = measureWire(host, list, team)
    return shape ? [{ lead: team.lead, shape }] : []
  })

// Every team's wire on the rail's border, while the Terminals list shows: the border between
// the rail and the sidebar is drawn from each team's topmost tab to its bottommost, a block
// cursor marks the lead, and a tick runs from the wire into each worker's tab. Every wire
// rests, dim, so who leads whom shows without selecting anything; the selected terminal's
// team lights, and plays its entrance each time one of its members is selected: the segment
// grows, the ticks reach out and the cursor blinks. It sits over the workspace body, beside
// the rail and the sidebar, as the sidebar clips what's drawn outside it; it takes no
// pointer and is only drawn, as the window's header says who leads a terminal in words.
export const TeamWire = ({
  teams,
  team,
  selected,
  shown,
  list,
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
}): React.JSX.Element => {
  const host = useRef<HTMLDivElement>(null)
  const [wires, setWires] = useState<Wires>([])
  // The selection whose entrance has played. Any change of selection forgets it, so coming
  // back to a member before the timer below fires plays the entrance again.
  const [played, setPlayed] = useState<string | undefined>(undefined)
  const [seen, setSeen] = useState(selected)
  if (seen !== selected) {
    setSeen(selected)
    setPlayed(undefined)
  }

  // Everything that keeps the wires on the tabs while the list shows: one run owns its
  // observers, listeners and frame loop, and its cleanup ends them all, so a change of teams
  // or of the list's visibility never leaves an earlier run measuring.
  useLayoutEffect(() => {
    const element = host.current
    const body = element?.parentElement
    if (!element || !body || !list || !teams.length || !shown) return
    const measure = () => {
      const next = measureWires(element, list, teams)
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
  }, [teams, shown, list])

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
  return (
    <div
      ref={host}
      className="team-wire"
      aria-hidden
      data-settled={played === selected || undefined}
    >
      {drawn.map((wire) => wire !== lit && <Wire key={wire.lead} shape={wire.shape} lit={false} />)}
      {lit && <Wire key={`${lit.lead}:${selected}`} shape={lit.shape} lit />}
    </div>
  )
}

const Wire = ({ shape, lit }: { shape: WireShape; lit: boolean }): React.JSX.Element => (
  <div className="team-wire-shape" data-lit={lit || undefined}>
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
    {shape.lead !== undefined && (
      <i className="team-wire-cursor" style={{ left: shape.x, top: shape.lead }} />
    )}
  </div>
)

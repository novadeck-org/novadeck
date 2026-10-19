import type { Team } from "@novadeck/core/derivations"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

import { blinkMs, wireShape, type WireMember, type WireShape } from "./team-wire"

// How long the wire keeps measuring after something that moves the tabs without a layout
// change it can observe: a drop's settle (180ms) and the sidebar's slide.
const settleMs = 400

const sameShape = (a: WireShape | undefined, b: WireShape | undefined) =>
  JSON.stringify(a) === JSON.stringify(b)

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

// The selected terminal's team on the rail's border: while the Terminals list shows and
// the selected terminal has a team, the border between the rail and the sidebar lights
// from the team's topmost tab to its bottommost, a block cursor marks the lead, and a tick
// runs from the wire into each worker's tab. Selecting a member sends one pulse out from
// the lead along the wire. It sits over the workspace body, beside the rail and the
// sidebar, as the sidebar clips what's drawn outside it; it takes no pointer and is only
// drawn, as the window's header says who leads a terminal in words.
export const TeamWire = ({
  team,
  selected,
  shown,
  list,
}: {
  team: Team | undefined
  // The selected terminal: selecting another member plays the pulse again.
  selected: string
  // Whether the Terminals list is on screen.
  shown: boolean
  // The Terminals list's element, a new one in each session and in each of the drawer and
  // the side pane.
  list: HTMLElement | null
}): React.JSX.Element => {
  const host = useRef<HTMLDivElement>(null)
  const [shape, setShape] = useState<WireShape | undefined>(undefined)
  // The selection whose pulse has played.
  const [played, setPlayed] = useState<string | undefined>(undefined)

  // Everything that keeps the wire on the tabs, for this team while the list shows: one
  // run owns its observers, listeners and frame loop, and its cleanup ends them all, so a
  // change of team or of the list's visibility never leaves an earlier run measuring.
  useLayoutEffect(() => {
    const element = host.current
    const body = element?.parentElement
    if (!element || !body || !list || !team || !shown) return
    const measure = () => {
      const next = measureWire(element, list, team)
      setShape((current) => (sameShape(current, next) ? current : next))
    }
    // Measures every frame until `until`, through moves no observer reports: a drag, its
    // drop and the sidebar sliding in.
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
  }, [team, shown, list])

  // The pulse plays once each time a member is selected; redraws after it put the wire in
  // place without playing it again.
  useEffect(() => {
    const timer = setTimeout(() => setPlayed(selected), blinkMs + 900)
    return () => clearTimeout(timer)
  }, [selected])

  // What the last run measured counts only while a team shows in a list.
  const drawn = team && shown && list ? shape : undefined
  return (
    <div
      ref={host}
      className="team-wire"
      aria-hidden
      data-settled={played === selected || undefined}
      style={{ "--team-wire-blink": `${blinkMs}ms` } as React.CSSProperties}
    >
      {drawn && (
        <div key={selected} className="team-wire-shape">
          <i
            className="team-wire-segment"
            style={{ left: drawn.x, top: drawn.top, height: drawn.bottom - drawn.top }}
          />
          {drawn.lead !== undefined && (
            <i className="team-wire-cursor" style={{ left: drawn.x, top: drawn.lead }} />
          )}
          {drawn.taps.map((tap) => (
            <i
              key={tap.id}
              className="team-wire-tap"
              style={
                {
                  left: drawn.x + 1,
                  top: tap.y,
                  width: tap.width,
                  "--_at": `${tap.at}ms`,
                } as React.CSSProperties
              }
            />
          ))}
          {drawn.pulse &&
            [drawn.pulse.down, -drawn.pulse.up]
              .filter((run) => Math.abs(run) > 4)
              .map((run) => (
                <i
                  key={run > 0 ? "down" : "up"}
                  className="team-wire-pulse"
                  style={
                    {
                      left: drawn.x,
                      top: drawn.lead,
                      "--_run": `${run}px`,
                      "--_duration": `${drawn.pulse!.duration}ms`,
                    } as React.CSSProperties
                  }
                />
              ))}
        </div>
      )}
    </div>
  )
}

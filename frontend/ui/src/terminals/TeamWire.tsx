import type { LitTeams, Team } from "@novadeck/core/derivations"
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react"

import { memberPiece, teamPiece, useEnteringPieces } from "./team-news"
import {
  foldGutter,
  wireShape,
  type FoldGutter,
  type WireMember,
  type WireShape,
} from "./team-wire"

// How long the wire keeps measuring after something that moves the tabs without a layout
// change it can observe: a drop's settle (180ms) and the sidebar's first frames once shown.
const settleMs = 400

const sameDrawing = (a: Drawing, b: Drawing) => JSON.stringify(a) === JSON.stringify(b)

// The scroll timeline the list lends the wire (team-wire.css): the wire is measured in the
// list's own frame, so a scroll moves it on the compositor with the tabs and measures nothing.
// Where the engine has no scroll timelines, a scroll listener moves it instead.
const scrollTimeline = "--team-wire-list"
const followsOnCompositor = () =>
  typeof CSS !== "undefined" &&
  CSS.supports?.("animation-timeline", "scroll()") === true &&
  CSS.supports("timeline-scope", scrollTimeline)

// Nested teams (a teammate that leads its own): each level's wire runs in its own lane, a
// lane's width further from the rail's border than its lead's lead's, and a nested team's
// tabs step in as far (tabs.css), so each sits beside its lane. Past two lanes, which keep
// clear of the tabs' edge, deeper teams share the innermost.
const laneWidth = 6
const deepestLane = 2
const laneOf = (level: number) => Math.min(level, deepestLane) * laneWidth

// Whether a tab is laid out: a teammate folded out of the list (team-fold.ts) isn't.
const laidOut = (tab: Element) => tab.getClientRects().length > 0

// Whether a teammate's tab is on its way out of the list: it stays laid out while it collapses.
const goingAway = (tab: Element) => tab.getAttribute("data-team-fold") === "away"

// Where the wire is measured from: the wire layer's left edge, and the top of the list's
// content, scrolled or not, so nothing measured changes as the list scrolls.
type Origin = { readonly left: number; readonly top: number }

// Where a tab's name line sits, and its left edge, in the wire's frame. While the tab is
// renamed its name gives way to a field, so the line is taken from the tab's top.
const memberOf = (tab: Element, id: string, origin: Origin): WireMember => {
  const rect = tab.getBoundingClientRect()
  const name = tab.querySelector(".sidebar-item-copy strong")?.getBoundingClientRect()
  const y = name ? name.top + name.height / 2 : rect.top + 19
  return { id, y: y - origin.top, left: rect.left - origin.left }
}

// A team's wire as measured: its shape, the gutter beside its lead's tab where pointing arms
// its fold, and while it's folded, the middles of the rows its lead holds for its teammates.
type Measured = {
  readonly shape: WireShape
  readonly gutter: FoldGutter | undefined
  readonly ghost: readonly number[]
  // How far a tick reaches from the wire to the lead's tab, for those rows.
  readonly ghostWidth: number
  // What it was measured from, for the lit way up through a lead (`path` in LitTeams).
  readonly head: WireMember
  readonly members: readonly WireMember[]
  readonly view: { readonly top: number; readonly bottom: number }
}

// Measures the wire for `team` against the page as it is now, in the list's content's frame
// (`origin`), where `view` is the whole content, scrolled into view or not: none while the
// rail isn't laid out (as on a phone) or the lead's tab is missing. A folded team's workers'
// tabs aren't laid out, and its wire is its lead's cursor alone.
const measureWire = (
  list: Element,
  railRect: DOMRect,
  origin: Origin,
  view: { readonly top: number; readonly bottom: number },
  team: Team,
  folded: boolean,
  level: number,
): Measured | undefined => {
  const tab = (id: string) => list.querySelector(`[data-terminal-tab-id="${CSS.escape(id)}"]`)
  const leadTab = tab(team.lead)
  const shown = team.workers.flatMap((id) => {
    const each = tab(id)
    return each && laidOut(each) ? [{ id, element: each }] : []
  })
  // A teammate going away while another stays leaves the wire at once, its tick riding no tab as
  // it collapses; a team going whole keeps them, its wire fading where it is.
  const staying = shown.filter(({ element }) => !goingAway(element))
  const workers = (staying.length ? staying : shown).map(({ id, element }) =>
    memberOf(element, id, origin),
  )
  if (!leadTab || !laidOut(leadTab) || !railRect.width) return undefined
  const x = railRect.right - origin.left - 1 + laneOf(level)
  const head = memberOf(leadTab, team.lead, origin)
  const shape = wireShape(x, view, head, workers)
  if (!shape) return undefined
  const leadRect = leadTab.getBoundingClientRect()
  const gutter = foldGutter(x, view, {
    top: leadRect.top - origin.top,
    height: leadRect.height,
    left: leadRect.left - origin.left,
  })
  // Folded, the rows the lead's tab holds for its teammates, each of which unfolds into a tab:
  // pointing beside the lead ties a ghost of the wire to them, so it says how much unfolds
  // without guessing where in the list the tabs come back.
  const ghost =
    folded && !workers.length && shape.lead !== undefined
      ? [...leadTab.querySelectorAll(".team-fold-row")].flatMap((row) => {
          const rect = row.getBoundingClientRect()
          const y = Math.round(rect.top + rect.height / 2 - origin.top)
          return y > shape.lead! && y <= view.bottom ? [y] : []
        })
      : []
  const ghostWidth = Math.max(0, Math.round(leadRect.left - origin.left) - shape.x)
  return { shape, gutter, ghost, ghostWidth, head, members: workers, view }
}

// Every team's wire, by its lead, in the teams' order.
type Wires = readonly ({ readonly lead: string } & Measured)[]

// The wires, and the frame they're drawn in: the list's room in the layer, which clips them,
// and how far the list scrolls, which the scroll timeline moves them over.
type Drawing = {
  readonly frame: { readonly top: number; readonly height: number; readonly range: number }
  readonly wires: Wires
}
const noDrawing: Drawing = { frame: { top: 0, height: 0, range: 0 }, wires: [] }

const measureWires = (
  layer: HTMLElement,
  list: HTMLElement,
  teams: readonly Team[],
  folded: readonly string[],
  levels: readonly number[],
): Drawing => {
  const rail = layer.parentElement?.querySelector(":scope > .sidebar-tools")
  if (!rail) return noDrawing
  const railRect = rail.getBoundingClientRect()
  const layerRect = layer.getBoundingClientRect()
  const listRect = list.getBoundingClientRect()
  // The list's room, on a whole pixel of the layer, which the wires are measured from too, so
  // they keep landing on whole pixels as they did on the layer.
  const frameTop = Math.round(listRect.top + list.clientTop - layerRect.top)
  const origin = { left: layerRect.left, top: layerRect.top + frameTop - list.scrollTop }
  const view = { top: 0, bottom: list.scrollHeight }
  const wires = teams.flatMap((team, index) => {
    const measured = measureWire(
      list,
      railRect,
      origin,
      view,
      team,
      folded.includes(team.lead),
      levels[index] ?? 0,
    )
    return measured ? [{ lead: team.lead, ...measured }] : []
  })
  const frame = {
    top: frameTop,
    height: list.clientHeight,
    range: Math.max(0, list.scrollHeight - list.clientHeight),
  }
  return { frame, wires }
}

// Every team's wire on the rail's border, while the Terminals list shows: the border between
// the rail and the sidebar is drawn from each team's topmost tab to its bottommost, a block
// cursor marks the lead, and a tick runs from the wire to each worker's tab. Every wire
// rests, dim, so who leads whom shows without selecting anything; the selected terminal's
// team lights. Only a change to a team plays (team-news.ts): a team forming draws in, its
// segment growing and its ticks reaching out, and a teammate joining reaches out its tick.
// It sits over the workspace body, beside the rail and the sidebar, as the sidebar clips
// what's drawn outside it, in the list's room, and scrolls with the list; it takes no
// pointer and is only drawn, as the window's header says who leads a terminal in words, but
// for the gutter beside each lead's tab, which folds its teammates out of the list (or shows
// them again) for a person who only follows the lead. Pointing there shows what a click does,
// with no words: the wire reels into the lead's cursor as its teammates' tabs dim, or, folded,
// a dashed ghost of it runs down the lead's rows for its teammates, a tick into each. The pointer has to come to the
// gutter on purpose: nothing over the tab itself arms it, and after a click it arms again only
// once the pointer has left. The lead's menu is the keyboard's way to the same fold. A team
// inside another (its lead a teammate) runs in a lane further in, and its parent's tick runs
// into its lead's cursor, so the gutter reads as a tree; what lights is every team the selected
// terminal leads or works in, and the way up through each lead above it.
export const TeamWire = ({
  teams,
  levels = noLevels,
  chains = noChains,
  lit = noLit,
  above = noLeads,
  selected,
  shown,
  list,
  folded = noLeads,
  unfolding,
  onFold,
  onPreview,
}: {
  teams: readonly Team[]
  // How many leads stand above each team's lead, in the teams' order: its lane; and the leads
  // above it, nearest first, space-separated, whose folds fade its wire too.
  levels?: readonly number[]
  chains?: readonly string[]
  // What lights for the selected terminal (core's litTeams), and the leads above it, whose
  // folded teams show the way down to it.
  lit?: LitTeams
  above?: readonly string[]
  // The selected terminal.
  selected: string
  // Whether the Terminals list is on screen.
  shown: boolean
  // The Terminals list's element, a new one in each session and in each of the drawer and
  // the side pane.
  list: HTMLElement | null
  // The leads whose teams the person folded out of the list, and the one they just unfolded,
  // whose wire fades back in as its tabs unroll.
  folded?: readonly string[]
  unfolding?: string | undefined
  // Folds a lead's team, or shows it again; without it, no gutter takes the pointer.
  onFold?: ((lead: string) => void) | undefined
  // Says which lead's gutter the person points at, so its teammates' tabs show what a click
  // does, or that they point at none. Kept the same from render to render: a new one ends the
  // preview the last one set.
  onPreview?: ((lead: string | null) => void) | undefined
}): React.JSX.Element => {
  const layer = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [drawing, setDrawing] = useState(noDrawing)
  // The lead whose gutter the person points at, and whether they clicked there since they
  // came, which holds it until they leave.
  const [armed, setArmed] = useState<string | undefined>(undefined)
  const spent = useRef<string | undefined>(undefined)
  const entering = useEnteringPieces(teams, shown && list !== null)
  // Measures the wires now, while a run keeps them on the tabs.
  const measureNow = useRef<(() => void) | undefined>(undefined)

  // Everything that keeps the wires on the tabs while the list shows: one run owns its
  // observers, listeners and frame loop, and its cleanup ends them all, so a change of teams
  // or of the list's visibility never leaves an earlier run measuring. A scroll measures
  // nothing: the wires are measured in the list's frame and scroll with it.
  useLayoutEffect(() => {
    const element = layer.current
    const body = element?.parentElement
    if (!element || !body || !list || !teams.length || !shown) return
    const measure = () => {
      const next = measureWires(element, list, teams, folded, levels)
      setDrawing((current) => (sameDrawing(current, next) ? current : next))
    }
    measureNow.current = measure
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
    // The list's scroll moves the wires: on the compositor through the list's scroll timeline,
    // or, without one, by a listener that moves them and measures nothing.
    const compositor = followsOnCompositor()
    const scrolled = () => {
      if (track.current) track.current.style.transform = `translateY(${-list.scrollTop}px)`
    }
    if (compositor) list.style.setProperty("scroll-timeline", `${scrollTimeline} block`)
    else {
      scrolled()
      list.addEventListener("scroll", scrolled, { passive: true })
    }
    measure()
    follow(settleMs)
    watch()
    changed.observe(list, { childList: true })
    list.addEventListener("pointerdown", drag)
    list.addEventListener("keydown", key)
    window.addEventListener("pointerup", drop, { capture: true })
    window.addEventListener("pointercancel", drop, { capture: true })
    window.addEventListener("blur", drop)
    return () => {
      measureNow.current = undefined
      dragging = false
      cancelAnimationFrame(frame)
      resized.disconnect()
      changed.disconnect()
      if (compositor) list.style.removeProperty("scroll-timeline")
      else list.removeEventListener("scroll", scrolled)
      list.removeEventListener("pointerdown", drag)
      list.removeEventListener("keydown", key)
      window.removeEventListener("pointerup", drop, { capture: true })
      window.removeEventListener("pointercancel", drop, { capture: true })
      window.removeEventListener("blur", drop)
    }
  }, [teams, shown, list, folded, levels])

  // A selection can swap which of a folded team's tabs shows, in the same commit: the wire
  // takes the tabs' new places before that frame paints, never reaching the one going away.
  // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The selection moves the tabs.
  useLayoutEffect(() => measureNow.current?.(), [selected])

  // What the last run measured counts only while teams show in a list. Each wire keeps its
  // place whether it lights or rests, so lighting fades rather than redraws; the stylesheet
  // raises the lit ones over the rest.
  const showing = teams.length > 0 && shown && list !== null
  const drawn = showing ? drawing.wires : []
  const litLeads = new Set(lit.full.map(({ lead }) => lead))
  // The way up: each lead above, its wire from its cursor to the member below it on the way.
  const path = lit.path.flatMap(({ lead, child }) => {
    const wire = drawn.find((each) => each.lead === lead)
    const member = wire?.members.find((each) => each.id === child)
    const shape = wire && member && wireShape(wire.shape.x, wire.view, wire.head, [member])
    return wire && shape ? [{ ...wire, shape, ghost: [] }] : []
  })
  // A folded team shows no wire but its lead's cursor, unless the selected terminal is in it,
  // which shows in its place with the way down to it. A team under a folded lead fades whole
  // with the fold, resting or lit, unless the person is on its lead or below it, which shows in
  // place; and fades back in as a lead above it unfolds.
  const chainOf = (lead: string) =>
    chains[teams.findIndex((each) => each.lead === lead)]?.split(" ") ?? []
  // A folded lead keeps its cursor ("wire": the rest fades); a team folded away under a lead
  // above it fades whole, its lead's cursor too ("all"), as its lead's tab folds away.
  const faded = (lead: string): "wire" | "all" | undefined =>
    folded.includes(lead)
      ? above.includes(lead)
        ? undefined
        : "wire"
      : chainOf(lead).some((each) => folded.includes(each)) &&
          selected !== lead &&
          !above.includes(lead)
        ? "all"
        : undefined
  // Pointing beside an unfolded lead previews its fold all the way down: the teams under it
  // reel in with its own wire, unless the person is on one of them, which the click keeps.
  const reeling = (lead: string) =>
    armed !== undefined &&
    armed !== lead &&
    !folded.includes(armed) &&
    chainOf(lead).includes(armed) &&
    selected !== lead &&
    !above.includes(lead)
  const unfoldingOf = (lead: string) =>
    unfolding !== undefined && (unfolding === lead || chainOf(lead).includes(unfolding))
  // A gutter that goes away under the pointer, as the sidebar hides, the session changes or the
  // team ends, hears no leave: what pointing there armed ends with it (here), the preview it set ends as it does (below), and a click there
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
  const { frame } = drawing
  return (
    <div ref={layer} className="team-wire" aria-hidden>
      <div
        className="team-wire-view"
        style={{ top: frame.top, height: showing ? frame.height : 0 }}
      >
        <div
          ref={track}
          className="team-wire-track"
          style={{ "--_range": `${frame.range}px` } as CSSProperties}
        >
          {drawn.map((wire) => (
            <Wire
              key={wire.lead}
              wire={wire}
              lit={litLeads.has(wire.lead)}
              folded={folded.includes(wire.lead)}
              faded={faded(wire.lead)}
              unfolding={unfoldingOf(wire.lead)}
              armed={armed === wire.lead}
              reeling={reeling(wire.lead)}
              entering={entering.has(teamPiece(wire.lead))}
              joining={(id) => entering.has(memberPiece(wire.lead, id))}
            />
          ))}
          {path.map((wire) => (
            <Wire
              path
              key={`path:${wire.lead}`}
              wire={wire}
              lit
              folded={false}
              faded={undefined}
              unfolding={unfoldingOf(wire.lead)}
              armed={armed === wire.lead}
              reeling={false}
              entering={false}
              joining={never}
            />
          ))}
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
      </div>
    </div>
  )
}
const noLeads: readonly string[] = []
const noLevels: readonly number[] = []
const noChains: readonly string[] = []
const noLit: LitTeams = { full: [], path: [] }
const never = () => false

const Wire = ({
  wire: { lead, shape, ghost, ghostWidth },
  path = false,
  lit,
  folded,
  faded,
  unfolding,
  armed,
  reeling,
  entering,
  joining,
}: {
  wire: Measured & { readonly lead: string }
  // The lit way up through a lead above the selected terminal, drawn over its resting wire.
  path?: boolean
  lit: boolean
  folded: boolean
  // Its segment and ticks faded out, as its team is folded and no teammate shows ("wire"), or
  // its cursor too, as its lead folds away under a lead above it ("all").
  faded: "wire" | "all" | undefined
  unfolding: boolean
  armed: boolean
  // A team under the lead whose gutter the person points at: it reels in with that lead's wire.
  reeling: boolean
  // Its team just formed, and draws in whole; a teammate who just joined it reaches out alone.
  entering: boolean
  joining: (id: string) => boolean
}): React.JSX.Element => (
  <div
    className="team-wire-shape"
    data-lead={lead}
    data-path={path || undefined}
    data-lit={lit || undefined}
    data-folded={folded || undefined}
    data-faded={faded}
    data-unfolding={unfolding || undefined}
    data-armed={armed || undefined}
    data-reeling={reeling || undefined}
    data-entering={entering || undefined}
  >
    <i
      className="team-wire-segment"
      style={{ left: shape.x, top: shape.top, height: shape.height }}
    />
    {shape.taps.map((tap) => (
      <i
        key={tap.id}
        className="team-wire-tap"
        data-joining={joining(tap.id) || undefined}
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
            style={{
              left: shape.x,
              top: y,
              width: ghostWidth,
              transitionDelay: `${180 + index * 90}ms`,
            }}
          />
        ))}
      </>
    )}
    {shape.lead !== undefined && (
      <i className="team-wire-cursor" style={{ left: shape.x, top: shape.lead }} />
    )}
  </div>
)

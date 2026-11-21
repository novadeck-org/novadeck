import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { firstTarget, targetElements, type TargetsOf } from "./anchors"
import { placeBox, sameBox, type Box } from "./place"
import { tourActs, type Coach, type TourAct } from "./steps"

import "./print.css"

// How often the stage looks for the footer's middle, which comes and goes with Zen.
const lookMs = 120
// How long an act's wipe stays: it slides in, stamps its name, and slides off while the act's
// first moves already play under it.
const wipeMs = 1_300
// The acts a wipe opens, the tour's two cuts: its start, as the person's agent takes the stage,
// and the result, as what the team made comes out. The acts between follow on with their
// captions alone.
const cuts: ReadonlySet<TourAct> = new Set<TourAct>([1, 4])

const boxOf = (element: Element | null): Box | null => {
  if (!element) return null
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

const sameBoxes = (a: readonly Box[], b: readonly Box[]): boolean =>
  a.length === b.length && a.every((box, index) => sameBox(box, b[index] ?? null))

// What the stage reads off the page: the window holding what its step marks, which the caption
// box stands beside, the workspace, and every window drawn in it.
type Scene = {
  readonly subject: Box | null
  readonly area: Box | null
  readonly windows: readonly Box[]
}

const noScene: Scene = { subject: null, area: null, windows: [] }

const sameScene = (a: Scene, b: Scene): boolean =>
  sameBox(a.subject, b.subject) && sameBox(a.area, b.area) && sameBoxes(a.windows, b.windows)

const drawn = (box: Box | null): box is Box => box !== null && box.width > 0 && box.height > 0

// The attributes the stage puts on what its step marks: where to look, and what to press. Each
// marked element gets a mark of its kind, which print.css draws a set gap out from it, over all
// it holds, so none of its parts paints over the mark. The mark goes in its host: the element
// itself, or, where something cuts off what goes past the element's edges too close to it for
// the gap (the element itself, as a window does, or a list or window it's in), the nearest box
// past that. Inside the workspace a host is never past the element's window, so a mark moves
// with its window as the view pans. A host that isn't positioned is made so
// (`data-tour-anchor`), to hold it.
const lookMark = "data-tour-look"
const clickMark = "data-tour-click"
const host = "data-tour-host"
const anchor = "data-tour-anchor"

// How far out from what it marks a mark stands, wherever the page leaves room.
const markGap = 6

const kindOf = (mark: string): string => (mark === lookMark ? "look" : "click")

const clips = (element: Element): boolean => {
  const { overflowX, overflowY } = getComputedStyle(element)
  return overflowX !== "visible" || overflowY !== "visible"
}

// The least room `box` has on any side within `edge`.
const roomIn = (box: DOMRect, edge: DOMRect): number =>
  Math.min(
    box.top - edge.top,
    edge.right - box.right,
    edge.bottom - box.bottom,
    box.left - edge.left,
  )

// Whether a mark may be hosted past `around`, which cuts off what overflows it: past the element
// itself, a window or anything in one; and past anything at all outside the workspace (as the
// Inbox's list). Never past a view's own frame, which pans what's in it.
const mayPass = (around: HTMLElement, element: HTMLElement): boolean =>
  around === element ||
  around.closest("[data-terminal]") !== null ||
  element.closest("[data-workspace-area]") === null

const hostOf = (element: HTMLElement, box: DOMRect): HTMLElement => {
  const gap = markGap * (element.offsetWidth > 0 ? box.width / element.offsetWidth : 1)
  let place = element
  for (let around: HTMLElement | null = element; around && around !== document.body;) {
    const parent: HTMLElement | null = around.parentElement
    if (clips(around)) {
      const room = around === element ? 0 : roomIn(box, around.getBoundingClientRect())
      // An element it cuts off partway stays cut off with it.
      if (room < 0) break
      if (room < gap) {
        if (!parent || !mayPass(around, element)) break
        place = parent
      }
    }
    around = parent
  }
  return place
}

// The gap the mark can have on each side within whatever cuts off what overflows its host, in
// the host's own pixels (as Canvas scales it).
const gapsIn = (
  place: HTMLElement,
  element: HTMLElement,
  box: DOMRect,
  scale: number,
): readonly [number, number, number, number] => {
  const most = markGap * scale
  let [top, right, bottom, left] = [most, most, most, most]
  for (let around: HTMLElement | null = place; around; around = around.parentElement) {
    if (around === element || !clips(around)) continue
    const edge = around.getBoundingClientRect()
    top = Math.min(top, box.top - edge.top)
    right = Math.min(right, edge.right - box.right)
    bottom = Math.min(bottom, edge.bottom - box.bottom)
    left = Math.min(left, box.left - edge.left)
  }
  const local = (room: number): number => Math.max(0, Math.floor(room / scale))
  return [local(top), local(right), local(bottom), local(left)]
}

// Each marked element's marks, by kind, wherever they're hosted.
const drawnMarks = new WeakMap<HTMLElement, Map<string, HTMLElement>>()

// Takes the host's attributes off once it holds no mark.
const release = (place: HTMLElement | null): void => {
  if (!place || place.querySelector(":scope > .tour-mark")) return
  place.removeAttribute(host)
  place.removeAttribute(anchor)
}

// The mark of `mark`'s kind for `element`, put in its host if it isn't there (as when a view
// redrew it or the host changed), and kept over the element with its gap.
const drawMark = (element: HTMLElement, mark: string): void => {
  const kind = kindOf(mark)
  const box = element.getBoundingClientRect()
  const place = hostOf(element, box)
  const marks = drawnMarks.get(element) ?? new Map<string, HTMLElement>()
  drawnMarks.set(element, marks)
  let line = marks.get(kind)
  if (line && line.parentElement !== place) {
    const was = line.parentElement
    line.remove()
    release(was)
    line = undefined
  }
  if (!line) {
    line = document.createElement("span")
    line.className = "tour-mark"
    line.dataset.tourMark = kind
    line.setAttribute("aria-hidden", "true")
    marks.set(kind, line)
  }
  if (!place.hasAttribute(host)) {
    place.setAttribute(host, "")
    if (getComputedStyle(place).position === "static") place.setAttribute(anchor, "")
  }
  if (line.parentElement !== place) place.append(line)
  const edge = place.getBoundingClientRect()
  const scale = place.offsetWidth > 0 ? edge.width / place.offsetWidth : 1
  const [top, right, bottom, left] = gapsIn(place, element, box, scale)
  const at = {
    left: `${(box.left - edge.left) / scale - place.clientLeft + place.scrollLeft - left}px`,
    top: `${(box.top - edge.top) / scale - place.clientTop + place.scrollTop - top}px`,
    width: `${box.width / scale + left + right}px`,
    height: `${box.height / scale + top + bottom}px`,
  }
  for (const [side, value] of Object.entries(at))
    if (line.style.getPropertyValue(side) !== value) line.style.setProperty(side, value)
}

const unmark = (element: HTMLElement, mark: string): void => {
  element.removeAttribute(mark)
  const marks = drawnMarks.get(element)
  const line = marks?.get(kindOf(mark))
  if (!line) return
  const was = line.parentElement
  line.remove()
  marks?.delete(kindOf(mark))
  release(was)
}

// What a coach marks now: where to look, and the first of its targets to press that's drawn.
const marksOf = (
  coach: Coach | null,
  lead: string,
  askingRow: string | null,
): { readonly look: HTMLElement[]; readonly click: HTMLElement[] } => {
  const where: TargetsOf = { lead, terminalId: coach?.terminalId ?? lead, askingRow }
  return {
    look: coach?.look ? targetElements(coach.look, where) : [],
    click: coach?.click ? firstTarget(coach.click, where) : [],
  }
}

// Puts `mark` on `next` and takes it off whatever had it before and doesn't now.
const remark = (mark: string, before: Set<HTMLElement>, next: readonly HTMLElement[]): void => {
  for (const element of before)
    if (!next.includes(element)) {
      unmark(element, mark)
      before.delete(element)
    }
  for (const element of next) {
    if (!before.has(element)) {
      element.setAttribute(mark, "")
      before.add(element)
    }
    drawMark(element, mark)
  }
}

const lookAt = (subject: HTMLElement | undefined): Scene => {
  const area = document.querySelector("[data-workspace-area]")
  // A part of a window (a message, its side pane) is named beside the window itself.
  const holder = subject?.closest("[data-terminal]") ?? subject ?? null
  return {
    subject: boxOf(holder),
    area: boxOf(area),
    windows: [...(area?.querySelectorAll("[data-terminal]") ?? [])].map(boxOf).filter(drawn),
  }
}

/**
 * Marks what the step points at on the page itself, every frame while the tour shows (as views
 * redraw what it marks), so the marks move with their elements however the person pans; and
 * reads the scene the caption box is placed in. Taken off as the tour goes.
 */
const useMarks = (
  coach: Coach | null,
  lead: string,
  askingRow: string | null,
  looking: boolean,
): Scene => {
  const [scene, setScene] = useState<Scene>(noScene)
  useEffect(() => {
    if (!looking) return
    const looked = new Set<HTMLElement>()
    const clicked = new Set<HTMLElement>()
    let frame = 0
    const tick = (): void => {
      const marks = marksOf(coach, lead, askingRow)
      remark(lookMark, looked, marks.look)
      remark(clickMark, clicked, marks.click)
      const next = lookAt(marks.look[0] ?? marks.click[0])
      setScene((current) => (sameScene(current, next) ? current : next))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      remark(lookMark, looked, [])
      remark(clickMark, clicked, [])
    }
  }, [coach, lead, askingRow, looking])
  return looking ? scene : noScene
}

// The footer's middle, where the stage's controls go beside whatever else stands there (as the
// No sandbox chip), so they cover none of it.
const footerSlot = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("footer.app-footer:not([hidden]) .footer-middle")

/** The footer's middle while it's drawn, looked at as the scene is. */
const useFooterSlot = (looking: boolean): HTMLElement | null => {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!looking) return
    const look = (): void => setSlot(footerSlot())
    look()
    const timer = setInterval(look, lookMs)
    return () => clearInterval(timer)
  }, [looking])
  return looking ? slot : null
}

const nameOf = (agent: AgentName): string => harnesses.find(({ id }) => id === agent)?.name ?? agent

// The small line under an act's name on its wipe.
const actLabel = (act: TourAct, agent: AgentName): string =>
  act === 1
    ? `${nameOf(agent)} · your account · a sandbox folder`
    : act === 2
      ? "Teammates your agent opens"
      : act === 3
        ? "A question for you"
        : "What they made"

/**
 * A cut's wipe, while its act is new: shown once as each act of `cuts` comes, over the page but
 * taking no pointer.
 */
const useWipe = (act: TourAct): TourAct | null => {
  const [wiping, setWiping] = useState<TourAct | null>(cuts.has(act) ? act : null)
  // A new act wipes in as it comes, set while rendering rather than a frame later.
  const [seen, setSeen] = useState(act)
  if (seen !== act) {
    setSeen(act)
    if (cuts.has(act)) setWiping(act)
  }
  useEffect(() => {
    if (wiping === null) return
    const timer = setTimeout(() => setWiping(null), wipeMs)
    return () => clearTimeout(timer)
  }, [wiping])
  return wiping
}

/**
 * The tour as it shows over the workspace, in a print look of its own: each act opened by a
 * wipe, marks on what its step points at (where to look, and what to press: `print.css`), and
 * one lettered caption box beside it in space no window takes, with End tour in the middle of
 * the app's footer, which no window takes either (or, with the footer hidden, at the workspace's
 * foot). It is no dialog: it takes no focus and covers nothing but its box and button, so the person's keys and
 * shortcuts work on as without it. While the person is in another project, a small bar takes
 * its place, to go back to it.
 */
export const TourStage = ({
  coach,
  terminalId,
  agent,
  act,
  askingRow,
  away,
  onEnd,
  onBack,
}: {
  readonly coach: Coach | null
  readonly terminalId: string
  readonly agent: AgentName
  readonly act: TourAct
  // The Inbox row of the team's question waiting now, which the stage marks to press.
  readonly askingRow: string | null
  // The tour's project isn't the one on screen.
  readonly away: boolean
  readonly onEnd: () => void
  readonly onBack: () => void
}): React.JSX.Element => {
  const scene = useMarks(coach, terminalId, askingRow, !away)
  const slot = useFooterSlot(!away)
  const wiping = useWipe(act)
  if (away)
    return (
      <section aria-label="Tour" className="tour-print tour-away">
        <span role="status">The tour goes on in its project.</span>
        <button type="button" className="tour-button tour-button-go" onClick={onBack}>
          Back to the tour
        </button>
        <button type="button" className="tour-button" onClick={onEnd}>
          End tour
        </button>
      </section>
    )
  const { area } = scene
  return (
    <div className="tour-print">
      {coach && area && (
        <CaptionBox
          key={coach.line}
          coach={coach}
          scene={scene}
          area={area}
          tilt={act % 2 === 0 ? "right" : "left"}
          clear={slot ? [] : footlessControls(area)}
        />
      )}
      {/* What the person hears: one region for the whole run, its act and words. */}
      <p aria-live="polite" className="sr-only">
        {`Act ${act}, ${tourActs[act - 1]}.${coach ? ` ${coach.line}` : ""}${coach?.note ? ` ${coach.note}` : ""}`}
      </p>
      {area &&
        (slot ? (
          createPortal(<Controls onEnd={onEnd} />, slot)
        ) : (
          <div
            className="tour-controls tour-controls-free"
            style={{ left: area.left + area.width / 2, top: area.top + area.height - 24 }}
          >
            <Controls onEnd={onEnd} />
          </div>
        ))}
      {wiping !== null && (
        <div aria-hidden="true" className="tour-wipe">
          <span className="tour-wipe-name">
            <span className="tour-wipe-say">{tourActs[wiping - 1]}</span>
            <span className="tour-wipe-label">{actLabel(wiping, agent)}</span>
          </span>
        </div>
      )}
    </div>
  )
}

// The stage's control, End tour: in the footer's middle, or, with the footer hidden (as in Zen),
// at the workspace's foot. Which act is on, the live region says.
const Controls = ({ onEnd }: { readonly onEnd: () => void }): React.JSX.Element => (
  <span className="tour-print tour-controls">
    <button type="button" className="tour-button" onClick={onEnd}>
      End tour
    </button>
  </span>
)

// Where the controls stand at the workspace's foot, which the caption box keeps clear of.
const controlsWidth = 110
const footlessControls = (area: Box): readonly Box[] => [
  {
    left: area.left + (area.width - controlsWidth) / 2,
    top: area.top + area.height - 48,
    width: controlsWidth,
    height: 48,
  },
]

// The step's caption box: its line lettered in Nyx's box from the skits, and a note under it for
// a moment the person has to act on; placed by its own size beside what it names.
// How long a caption box holds back once what its step marks shows, so the mark comes first and
// the box after it; and how long it waits at most for a mark that never shows.
const holdMs = 1_000
const holdAtMostMs = 3_000

const CaptionBox = ({
  coach,
  scene,
  area,
  tilt,
  clear,
}: {
  readonly coach: Coach
  readonly scene: Scene
  readonly area: Box
  // Which way it leans, alternating act by act, as the skits' boxes do.
  readonly tilt: "left" | "right"
  // What else it keeps clear of beside the windows.
  readonly clear: readonly Box[]
}): React.JSX.Element => {
  const box = useRef<HTMLElement>(null)
  // Shown a moment after what the step marks first shows on the page (a moment after it comes,
  // where it marks nothing), and from then on. Counted from the first time only: a mark the
  // view drops for a moment, as windows come and the camera reframes, doesn't start it over.
  const marks = coach.look !== undefined || (coach.click?.length ?? 0) > 0
  const pointed = !marks || scene.subject !== null
  const [pointedOnce, setPointedOnce] = useState(false)
  if (pointed && !pointedOnce) setPointedOnce(true)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (shown) return
    const timer = setTimeout(() => setShown(true), pointedOnce ? holdMs : holdAtMostMs)
    return () => clearTimeout(timer)
  }, [pointedOnce, shown])
  const [place, setPlace] = useState<{ readonly left: number; readonly top: number } | null>(null)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const placeNow = (): void => {
      const { width, height } = element.getBoundingClientRect()
      const keepClear = coach.overWindows ? clear : [...scene.windows, ...clear]
      const placed = placeBox(scene.subject, { width, height }, area, keepClear)
      setPlace((current) =>
        current && current.left === placed.left && current.top === placed.top ? current : placed,
      )
    }
    placeNow()
    const sized = new ResizeObserver(placeNow)
    sized.observe(element)
    return () => sized.disconnect()
  }, [scene, area, clear, coach.overWindows])
  return (
    <section
      ref={box}
      aria-label="Tour step"
      className="tour-caption"
      data-shown={shown || undefined}
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
    >
      <div className="tour-caption-panel" data-tilt={tilt}>
        <p className="tour-caption-line">{coach.line}</p>
      </div>
      {coach.note && <p className="tour-caption-note">{coach.note}</p>}
    </section>
  )
}

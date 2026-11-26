import { harnesses, type AgentName } from "@novadeck/core/harnesses"
import { Tooltip } from "@novadeck/toolkit/Tooltip"
import { Eye, Volume2, VolumeOff } from "lucide-react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { createPortal } from "react-dom"

import { firstTarget, outOfSight, targetElements, windowSelector, type TargetsOf } from "./anchors"
import { captionDelayMs, hasPointed } from "./caption"
import { placeBox, sameBox, type Box } from "./place"
import { tourActs, type Coach, type TourAct } from "./steps"
import { tourVoice } from "./voice"

import "./print.css"

// How long what a step is about stays out of the person's sight before its caption box offers to
// bring it back ("Show me").
const lostMs = 2_500

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
  // The modal dialogs open now, which the caption box never lies over.
  readonly dialogs: readonly Box[]
  // Nothing it marks is in sight now, though it's there (off screen, or behind what the person
  // opened): the caption box offers to bring it back.
  readonly lost: boolean
  // The step's subject itself is drawn (the first of its click targets, or what it looks at
  // where it marks nothing to press), not only what opens it: its line may be said.
  readonly present: boolean
}

const noScene: Scene = {
  subject: null,
  area: null,
  windows: [],
  dialogs: [],
  lost: false,
  present: false,
}

const sameScene = (a: Scene, b: Scene): boolean =>
  a.lost === b.lost &&
  a.present === b.present &&
  sameBox(a.subject, b.subject) &&
  sameBox(a.area, b.area) &&
  sameBoxes(a.windows, b.windows) &&
  sameBoxes(a.dialogs, b.dialogs)

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
  around.closest(windowSelector) !== null ||
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
        // Never the page's body: a mark goes no further than the app's own parts.
        if (!parent || parent === document.body || !mayPass(around, element)) break
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

// Each marked element's marks, by kind, with the host each was put in (which a view redrawing it
// may have taken it out of).
type Drawn = { readonly line: HTMLElement; readonly place: HTMLElement }
const drawnMarks = new WeakMap<HTMLElement, Map<string, Drawn>>()

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
  const marks = drawnMarks.get(element) ?? new Map<string, Drawn>()
  drawnMarks.set(element, marks)
  const was = marks.get(kind)
  let line = was?.line
  if (was && was.place !== place) {
    was.line.remove()
    release(was.place)
  }
  if (!line) {
    line = document.createElement("span")
    line.className = "tour-mark"
    line.dataset.tourMark = kind
    line.setAttribute("aria-hidden", "true")
  }
  marks.set(kind, { line, place })
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
  const made = marks?.get(kindOf(mark))
  if (!made) return
  made.line.remove()
  marks?.delete(kindOf(mark))
  release(made.place)
}

// What a coach marks now: where to look, and the first of its targets to press that's drawn,
// and whether that is its first target, the subject of a step that waits on the person's touch.
const marksOf = (
  coach: Coach | null,
  where: TargetsOf,
): {
  readonly look: HTMLElement[]
  readonly click: HTMLElement[]
  readonly subject: boolean
  readonly lost: boolean
} => {
  const click = coach?.click ? firstTarget(coach.click, where) : { elements: [], index: -1 }
  const look = coach?.look ? targetElements(coach.look, where) : []
  const targets = [...(coach?.look ? [coach.look] : []), ...(coach?.click ?? [])]
  return {
    look,
    click: click.elements,
    subject: click.index === 0,
    lost:
      look.length === 0 &&
      click.elements.length === 0 &&
      targets.length > 0 &&
      outOfSight(targets, where),
  }
}

/**
 * Tells `onTouch` when the person touches one of `subject`'s elements: a press in it, or the focus
 * leaving the app's page for a frame in it, as a click into a page or a model in a frame of its
 * own does without a press the app sees. Never the focus moving within the app's page: selecting
 * a terminal (as the caption box's button does) focuses its input, which is no touch. A part of a
 * window counts with its whole window: on Canvas a window not selected takes the press itself, to
 * select it, whatever part is pressed.
 */
const useTouch = (marked: { readonly current: Marked }, onTouch: () => void, on: boolean): void => {
  useEffect(() => {
    if (!on) return
    const within = (elements: readonly HTMLElement[], node: unknown): boolean =>
      node instanceof Node &&
      elements.some((element) => (element.closest(windowSelector) ?? element).contains(node))
    const inSubject = (node: unknown): boolean => within(marked.current.subject, node)
    const pressed = (event: Event): void => {
      if (inSubject(event.target)) onTouch()
    }
    // A frame taking the focus blurs the page's window first; the focus is on it a moment later.
    let timer: ReturnType<typeof setTimeout> | undefined
    const blurred = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        // Only into a frame of its own: the app's whole window losing the focus (to another app)
        // leaves it where it was, as on a terminal's input in the subject's window.
        const focused = document.activeElement
        if (
          (focused instanceof HTMLIFrameElement || focused?.tagName === "WEBVIEW") &&
          inSubject(focused)
        )
          onTouch()
      })
    }
    document.addEventListener("pointerdown", pressed, true)
    window.addEventListener("blur", blurred)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("pointerdown", pressed, true)
      window.removeEventListener("blur", blurred)
    }
  }, [marked, onTouch, on])
}

// What the stage marks to press now where it is the subject of the coach's step, not what opens
// it: a press there is the person's touch.
type Marked = { readonly subject: readonly HTMLElement[] }

const noneMarked: Marked = { subject: [] }

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
  const holder = subject?.closest(windowSelector) ?? subject ?? null
  return {
    subject: boxOf(holder),
    area: boxOf(area),
    windows: [...(area?.querySelectorAll(windowSelector) ?? [])].map(boxOf).filter(drawn),
    dialogs: [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')]
      .map(boxOf)
      .filter(drawn),
    lost: false,
    present: false,
  }
}

// How often the stage marks again and reads the scene: a mark lies in its element or near it, so
// it moves with it between times however the person pans; only a view redrawing what it marks,
// or the element moving within its host, waits this long.
const markMs = 120

/**
 * Marks what the step points at on the page itself, every `markMs` while the tour shows (as views
 * redraw what it marks), and reads the scene the caption box is placed in, for the coach it was
 * read for: until the new coach's is read, the scene is none. Taken off as the tour goes.
 */
const useMarks = (
  coach: Coach | null,
  where: Omit<TargetsOf, "terminalId" | "tab">,
  looking: boolean,
  // Kept as the stage marks the coach's step's subject now.
  marked: { current: Marked },
): Scene => {
  const [read, setRead] = useState<{ readonly coach: Coach | null; readonly scene: Scene }>({
    coach: null,
    scene: noScene,
  })
  useEffect(() => {
    if (!looking) return
    const looked = new Set<HTMLElement>()
    const clicked = new Set<HTMLElement>()
    const tick = (): void => {
      const marks = marksOf(coach, {
        ...where,
        terminalId: coach?.terminalId ?? where.roles.lead ?? "",
        tab: coach?.tab,
      })
      remark(lookMark, looked, marks.look)
      remark(clickMark, clicked, marks.click)
      marked.current = { subject: marks.subject ? marks.click : [] }
      const next = {
        ...lookAt(marks.look[0] ?? marks.click[0]),
        lost: marks.lost,
        present: marks.subject || (coach?.click === undefined && marks.look.length > 0),
      }
      setRead((current) =>
        current.coach === coach && sameScene(current.scene, next)
          ? current
          : { coach, scene: next },
      )
    }
    const frame = requestAnimationFrame(tick)
    const timer = setInterval(tick, markMs)
    return () => {
      cancelAnimationFrame(frame)
      clearInterval(timer)
      remark(lookMark, looked, [])
      remark(clickMark, clicked, [])
      marked.current = noneMarked
    }
  }, [coach, where, looking, marked])
  return looking && read.coach === coach ? read.scene : noScene
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
    ? `${nameOf(agent)} · Novadeck's model · a sandbox repo`
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
  bring,
  roles,
  team,
  open,
  agent,
  act,
  askingRow,
  away,
  onCaption,
  onTouch,
  onShow,
  onEnd,
  onBack,
}: {
  readonly coach: Coach | null
  // Whether the caption box's button has something to bring into view now (`onShow`).
  readonly bring: boolean
  // The terminals of the roles found, and of the lead's teammates, which the stage marks.
  readonly roles: TargetsOf["roles"]
  readonly team: readonly string[]
  // What each role's pane shows now.
  readonly open: TargetsOf["open"]
  readonly agent: AgentName
  readonly act: TourAct
  // The Inbox row of the team's question waiting now, which the stage marks to press.
  readonly askingRow: string | null
  // The tour's project isn't the one on screen.
  readonly away: boolean
  // Told, with its line, when the step's caption box shows: the step's hold counts from then.
  readonly onCaption: (line: string) => void
  // Told, with its line, when the person touches what the step's caption marks as its subject.
  readonly onTouch: (line: string) => void
  // Brings what the step is about into view, as the person presses the caption box's button.
  readonly onShow: () => void
  readonly onEnd: () => void
  readonly onBack: () => void
}): React.JSX.Element => {
  const where = useMemo(() => ({ roles, team, askingRow, open }), [roles, team, askingRow, open])
  const marked = useRef<Marked>(noneMarked)
  const scene = useMarks(coach, where, !away, marked)
  const line = coach?.line
  const touch = useCallback((): void => {
    if (line !== undefined) onTouch(line)
  }, [line, onTouch])
  useTouch(marked, touch, !away && line !== undefined)
  // Its subject on screen at last, for this coach: its line is said from then on, wherever the
  // person takes it after (out of sight, "Show me" offers it back), never its cue again, even
  // where another box (a teammate's question) took its place a while. For this run: the stage
  // goes with it.
  const [presentFor, setPresentFor] = useState<readonly Coach[]>([])
  if (coach && !away && scene.present && !presentFor.includes(coach))
    setPresentFor([...presentFor, coach])
  const present = coach !== null && presentFor.includes(coach)
  // A subject the person had only to open (a sidebar panel) is touched by being on screen.
  const opened = present && coach?.opened === true
  useEffect(() => {
    if (opened) touch()
  }, [opened, touch])
  // What the box says: the step's cue, while its subject isn't on screen yet, else its line.
  const said =
    coach && (coach.cue && !present ? { ...coach.cue, cue: true } : { ...coach, cue: false })
  const slot = useFooterSlot(!away)
  const wiping = useWipe(act)
  // She stops as the tour goes out of sight, and as it ends.
  useEffect(() => {
    if (away) tourVoice.stop()
  }, [away])
  useEffect(() => () => tourVoice.stop(), [])
  // What else the caption box keeps clear of, kept while the same, so its placing isn't redone
  // on every render.
  const clear = useMemo(
    () => (slot || !scene.area ? noBoxes : footlessControls(scene.area)),
    [slot, scene.area],
  )
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
      {coach && said && area && (
        <CaptionBox
          key={said.line}
          coach={coach}
          said={said}
          bring={bring}
          scene={scene}
          area={area}
          tilt={act % 2 === 0 ? "right" : "left"}
          clear={clear}
          onShown={said.cue ? noCaption : onCaption}
          onShow={onShow}
        />
      )}
      {/* What the person hears: one region for the whole run, its act and words. */}
      <p aria-live="polite" className="sr-only">
        {`Act ${act}, ${tourActs[act - 1]}.${said ? ` ${said.line}` : ""}${said?.note ? ` ${said.note}` : ""}${scene.lost ? " It's out of sight: Show me, in the tour step, brings it back." : ""}`}
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

// The stage's controls, Nyx's voice on or off and End tour: in the footer's middle, or, with the
// footer hidden (as in Zen), at the workspace's foot. Which act is on, the live region says.
const Controls = ({ onEnd }: { readonly onEnd: () => void }): React.JSX.Element => {
  const speaking = useSyncExternalStore(tourVoice.subscribe, tourVoice.on)
  return (
    <span className="tour-print tour-controls">
      <Tooltip content={speaking ? "Narration on" : "Narration off"}>
        <button
          type="button"
          aria-label="Narration"
          aria-pressed={speaking}
          className="tour-button tour-voice"
          onClick={() => tourVoice.set(!speaking)}
        >
          {speaking ? (
            <Volume2 aria-hidden="true" size={15} strokeWidth={2.25} />
          ) : (
            <VolumeOff aria-hidden="true" size={15} strokeWidth={2.25} />
          )}
        </button>
      </Tooltip>
      <button type="button" className="tour-button" onClick={onEnd}>
        End tour
      </button>
    </span>
  )
}

// A cue's box showing is no caption of the step's: its hold counts from its line's.
const noCaption = (): void => {}

// Where the controls stand at the workspace's foot, which the caption box keeps clear of.
const controlsWidth = 150
const noBoxes: readonly Box[] = []
const footlessControls = (area: Box): readonly Box[] => [
  {
    left: area.left + (area.width - controlsWidth) / 2,
    top: area.top + area.height - 48,
    width: controlsWidth,
    height: 48,
  },
]

// The step's caption box: its line (or its cue) lettered in Nyx's box from the skits, a note
// under it for a moment the person has to act on, and, where the step has something to bring
// into view, a button that does; placed by its own size beside what it names.

const CaptionBox = ({
  coach,
  said,
  bring,
  scene,
  area,
  tilt,
  clear,
  onShown,
  onShow,
}: {
  readonly coach: Coach
  // What it says now: the coach's line and note, or its cue's.
  readonly said: {
    readonly line: string
    readonly note?: string | undefined
    readonly cue: boolean
  }
  readonly bring: boolean
  readonly scene: Scene
  readonly area: Box
  // Which way it leans, alternating act by act, as the skits' boxes do.
  readonly tilt: "left" | "right"
  // What else it keeps clear of beside the windows.
  readonly clear: readonly Box[]
  readonly onShown: (line: string) => void
  readonly onShow: () => void
}): React.JSX.Element => {
  const box = useRef<HTMLElement>(null)
  // Shown a moment after what the step marks first shows on the page (a moment after it comes,
  // where it marks nothing), and from then on. Counted from the first time only: a mark the
  // view drops for a moment, as windows come and the camera reframes, doesn't start it over.
  const marks = coach.look !== undefined || (coach.click?.length ?? 0) > 0
  const [pointedOnce, setPointedOnce] = useState(false)
  const pointed = hasPointed(pointedOnce, marks, scene.subject !== null)
  if (pointed !== pointedOnce) setPointedOnce(pointed)
  // What it's about has been out of the person's sight a while (they went elsewhere, or opened
  // something over it): the box shows all the same, offering to bring it back.
  const [lostLong, setLostLong] = useState(false)
  if (!scene.lost && lostLong) setLostLong(false)
  useEffect(() => {
    if (!scene.lost) return
    const timer = setTimeout(() => setLostLong(true), lostMs)
    return () => clearTimeout(timer)
  }, [scene.lost])
  // A cue shows where its button can bring its subject, too: what opens it may be nowhere drawn.
  const showing = pointedOnce || lostLong || (said.cue && bring)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (shown || !showing) return
    const timer = setTimeout(() => setShown(true), captionDelayMs)
    return () => clearTimeout(timer)
  }, [showing, shown])
  // Said once it shows, for the step's hold to count from.
  useEffect(() => {
    if (shown) onShown(said.line)
  }, [shown, onShown, said.line])
  // And Nyx says it, cue or line, as it shows.
  useEffect(() => {
    if (shown) tourVoice.say(said.line)
  }, [shown, said.line])
  const [place, setPlace] = useState<{ readonly left: number; readonly top: number } | null>(null)
  useLayoutEffect(() => {
    const element = box.current
    if (!element || !showing) return
    const placeNow = (): void => {
      const { width, height } = element.getBoundingClientRect()
      const keepClear = coach.overWindows ? clear : [...scene.windows, ...clear]
      const placed = placeBox(scene.subject, { width, height }, area, keepClear, scene.dialogs)
      setPlace((current) =>
        current && current.left === placed.left && current.top === placed.top ? current : placed,
      )
    }
    placeNow()
    const sized = new ResizeObserver(placeNow)
    sized.observe(element)
    return () => sized.disconnect()
  }, [scene, area, clear, coach.overWindows, showing])
  // No box on screen while its step has nothing to point at.
  if (!showing) return <></>
  return (
    <section
      ref={box}
      aria-label="Tour step"
      className="tour-caption"
      data-shown={shown || undefined}
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
    >
      <div className="tour-caption-head">
        <div className="tour-caption-panel" data-tilt={tilt}>
          <p className="tour-caption-line">{said.line}</p>
        </div>
        {(bring || lostLong) && (
          <Tooltip content="Show me">
            <button
              type="button"
              aria-label="Show me"
              className="tour-button tour-button-go tour-show"
              onClick={onShow}
            >
              <Eye aria-hidden="true" size={18} strokeWidth={2.25} />
            </button>
          </Tooltip>
        )}
      </div>
      {said.note && <p className="tour-caption-note">{said.note}</p>}
    </section>
  )
}

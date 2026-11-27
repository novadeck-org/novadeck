import { page, type Locator } from "vitest/browser"

import { expect } from "../test"
import { nameOf } from "./workspace"

// Vocabulary for the onboarding tour: its consent, its caption box and closing card, and what it
// marks on the page, which it draws on the page's own elements (`data-tour-look` where to look,
// `data-tour-click` what to press).

export const consent = (): Locator => page.getByRole("dialog", { name: "Take the tour" })
export const coach = (): Locator => page.getByRole("region", { name: "Tour step" })
// The caption box's eye, which brings what its step is about into view.
export const showMe = (): Locator => coach().getByRole("button", { name: "Show me" })
export const closing = (): Locator => page.getByRole("region", { name: "Tour finished" })

/**
 * Waits for the caption box to say `words`, among the rest of what it says, once it is shown
 * (`data-shown`: the box is in the page a second before that, and not yet seen). Read from the
 * page itself: a modal dialog (the approval) hides the rest of the app from the role queries, and
 * the box stays on screen beside it. The wait is long: a caption waits for what its step marks, and a
 * pane's first item loads its viewer first (the 3D one took over 20 s on a Windows runner).
 */
export const coachSays = (words: string, timeout = 40_000): Promise<void> =>
  expect
    .poll(
      () =>
        document.querySelector('section[aria-label="Tour step"][data-shown]')?.textContent ?? "",
      { timeout },
    )
    .toContain(words)

/** What the tour points to look at now, as drawn. */
export const looked = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>("[data-tour-look]"),
]

/** What it points to press now. */
export const clicked = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>("[data-tour-click]"),
]

/** A terminal's window by the name its title reads, wherever the view draws it. */
export const windowNamed = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[data-terminal]:not([data-terminal="true"])')].find(
    (element) => nameOf(element.getAttribute("aria-label") ?? "") === `${name} terminal`,
  )

/** The pane beside a terminal's window, by the terminal's name, where it has one open. */
export const paneOf = (name: string): HTMLElement | undefined => {
  const id = windowNamed(name)?.getAttribute("data-terminal")
  return id
    ? (document.querySelector<HTMLElement>(`[data-companion-of="${CSS.escape(id)}"]`) ?? undefined)
    : undefined
}

/** Waits until the tour marks, to look at, exactly the elements these find now. */
export const expectLookAt = (...find: readonly (() => HTMLElement | undefined)[]): Promise<void> =>
  expect
    .poll(
      () => {
        const marked = looked()
        const wanted = find.map((each) => each())
        return (
          marked.length === wanted.length && marked.every((element) => wanted.includes(element))
        )
      },
      { timeout: 15_000 },
    )
    .toBe(true)

/** Waits until the tour marks windows named so, and no others, to look at. */
export const expectLookAtWindows = (...names: readonly string[]): Promise<void> =>
  expect
    .poll(
      () =>
        looked()
          .map((each) => nameOf(each.getAttribute("aria-label") ?? "").replace(/ terminal$/, ""))
          .toSorted(),
      { timeout: 15_000 },
    )
    .toEqual(names.toSorted())

/**
 * What a pane shows now: the item on top, with its name in its header. The other tabs on its bar
 * are icons, so they add no words.
 */
export const topTab = (pane: HTMLElement | undefined): string => pane?.textContent ?? ""

/** Waits until the tour marks, to press, exactly the elements these find now. */
export const expectClickAt = (...find: readonly (() => HTMLElement | undefined)[]): Promise<void> =>
  expect
    .poll(
      () => {
        const marked = clicked()
        const wanted = find.map((each) => each())
        return (
          marked.length === wanted.length && marked.every((element) => wanted.includes(element))
        )
      },
      { timeout: 15_000 },
    )
    .toBe(true)

/** Waits until the tour marks windows named so, and no others, to press. */
export const expectClickAtWindows = (...names: readonly string[]): Promise<void> =>
  expect
    .poll(
      () =>
        clicked()
          .map((each) => nameOf(each.getAttribute("aria-label") ?? "").replace(/ terminal$/, ""))
          .toSorted(),
      { timeout: 15_000 },
    )
    .toEqual(names.toSorted())

/** Waits for the caption box to say any of `words`, and answers which. */
export const coachSaysAny = async (words: readonly string[], timeout = 40_000): Promise<string> => {
  let said = ""
  await expect
    .poll(
      () => {
        const now =
          document.querySelector('section[aria-label="Tour step"][data-shown]')?.textContent ?? ""
        said = words.find((each) => now.includes(each)) ?? ""
        return said
      },
      { timeout },
    )
    .not.toBe("")
  return said
}

/** What the tour says when something interrupts its story: a teammate's question, a permission ask. */
const interruptions = [
  "A teammate has a question. Huh? For you, not me.",
  "It's asking your permission. Read it first.",
]

/**
 * Whether the box gave way to what interrupts the story (frontend/tour's questionCoach and
 * permissionCoach): a teammate's question may take its place while the person goes to a step's
 * subject (a slow runner, 2026-11-25), and then what is marked is the question's, which the
 * story's next step answers, not this one. Any other line still fails the step as before.
 */
const interrupted = (): boolean => {
  const now =
    document.querySelector('section[aria-label="Tour step"][data-shown]')?.textContent ?? ""
  return interruptions.some((each) => now.includes(each))
}

/** A terminal's window, as the tour draws it on every view. */
const windowSelector = '[data-terminal]:not([data-terminal="true"])'

/** A window's header, which a press goes to (see `touchStep`), or the element itself. */
const headerOf = (marked: HTMLElement): HTMLElement =>
  marked.closest<HTMLElement>(windowSelector)?.querySelector<HTMLElement>(".terminal-header") ??
  marked

/** What a press on `marked` counts in, as the tour hears it: its whole window, or the element. */
const windowOf = (marked: HTMLElement): HTMLElement =>
  marked.closest<HTMLElement>(windowSelector) ?? marked

/** The middle of an element, where a press on it lands. */
const middleOf = (element: HTMLElement): { readonly x: number; readonly y: number } => {
  const box = element.getBoundingClientRect()
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
}

/**
 * Whether the middle of an element, where a press lands, is in the workspace's area on screen: not
 * past its edge, nor under the rail, a panel, the header or the footer.
 */
const onScreen = (element: HTMLElement): boolean => {
  const { x, y } = middleOf(element)
  const area = document.querySelector<HTMLElement>("[data-workspace-area]")?.getBoundingClientRect()
  const [left, top, right, bottom] = area
    ? [area.left, area.top, area.right, area.bottom]
    : [0, 0, window.innerWidth, window.innerHeight]
  return x >= left && y >= top && x <= right && y <= bottom
}

/** An element, briefly, for a failure to say what a press met. */
const named = (element: Element | null): string =>
  element === null
    ? "nothing"
    : `${element.tagName.toLowerCase()}${element.getAttribute("aria-label") ? ` "${element.getAttribute("aria-label")}"` : ""}${element.className && typeof element.className === "string" ? `.${element.className.split(/\s+/).slice(0, 3).join(".")}` : ""}`

/**
 * What is drawn over the middle of `marked`'s header, taking a press there: null where nothing
 * outside its window is (a window of its own, or a part of the window, as on Canvas the overlay
 * that selects a window not selected yet).
 */
const coverOf = (marked: HTMLElement): Element | null => {
  const { x, y } = middleOf(headerOf(marked))
  const hit = document.elementFromPoint(x, y)
  return hit !== null && windowOf(marked).contains(hit) ? null : (hit ?? document.body)
}

/** Of what the tour marks, one of `wanted` that a press can reach: on screen, and not covered. */
const reachable = (wanted: ReadonlySet<HTMLElement>): HTMLElement | undefined =>
  clicked().find((each) => wanted.has(each) && onScreen(headerOf(each)) && coverOf(each) === null)

/**
 * Presses `marked`'s window by its header, as `touchStep` does, and says where the press went
 * where it missed the window (null where it landed there): the view can move between the look
 * and the press (a window landing, the eye's move).
 */
const pressWindow = async (marked: HTMLElement): Promise<string | null> => {
  const within = windowOf(marked)
  const first: { target: EventTarget | null } = { target: null }
  const heard = (event: Event): void => {
    first.target ??= event.target
  }
  document.addEventListener("pointerdown", heard, true)
  try {
    // Forced: where the window takes the press itself (on Canvas, a window not selected takes it,
    // to select itself), a click would wait on the part that takes it; that it lands in the window
    // is checked here, instead. A press into a frame (a pane's page or model) is heard in the
    // frame's own page, not this one, so none heard counts as landed.
    await page.elementLocator(headerOf(marked)).click({ force: true, timeout: 3_000 })
  } catch (error) {
    return `the press failed (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`
  } finally {
    document.removeEventListener("pointerdown", heard, true)
  }
  const landed = first.target
  if (landed === null || (landed instanceof Node && within.contains(landed))) return null
  return `the press landed on ${named(landed instanceof Element ? landed : null)}`
}

/** What the caption box says now, once shown. */
const captionNow = (): string =>
  document.querySelector('section[aria-label="Tour step"][data-shown]')?.textContent ?? ""

/** How long ago an epoch-ms time was, or "not yet". */
const ago = (at: unknown): string =>
  typeof at === "number" ? `${Math.round((Date.now() - at) / 1000)} s ago` : "not yet"

/**
 * Where the tour's run is, as it keeps it in session storage (frontend/tour's `storageKey`), for a
 * failure to say: its step, and whether and when that step was touched and done.
 */
const runNow = (): string => {
  try {
    const run = JSON.parse(sessionStorage.getItem("novadeck.tour") ?? "null") as {
      readonly stepId?: unknown
      readonly touched?: unknown
      readonly doneAt?: unknown
    } | null
    if (!run) return "none kept"
    return `step ${String(run.stepId)}, touched ${ago(run.touched)}, done ${ago(run.doneAt)}`
  } catch {
    return "unreadable"
  }
}

/**
 * Plays a step that waits on the person, as they would: once its caption says `line` (or its
 * `cue`, said while its subject isn't on screen yet), presses what opens its subject where the
 * tour marks that first (the rail's button for a panel, a window whose pane isn't showing yet),
 * each once, then touches the subject itself, one of what `subject` finds, and waits for the
 * caption to move on: at once, or once the step's hold (`holdMs`) after the touch is over, as the
 * game's last step holds before its closing card comes.
 */
export const touchStep = async (
  line: string,
  subject: () => readonly (HTMLElement | undefined)[],
  {
    timeout = 40_000,
    holdMs = 0,
    cue,
  }: { readonly timeout?: number; readonly holdMs?: number; readonly cue?: string } = {},
): Promise<void> => {
  await coachSaysAny(cue === undefined ? [line] : [line, cue], timeout)
  const opened = new Set<HTMLElement>()
  let pressedAt = 0
  let displaced = false
  await expect
    .poll(
      async () => {
        if (interrupted()) {
          displaced = true
          return true
        }
        // Nothing pressed while the box shown isn't this step's own: as one box gives way to
        // another, the next is in the page a second before it shows, and what the tour marks may
        // already be the next box's. A teammate's question coming mid-step had its row and then
        // its answers pressed here as if they opened this step's subject, which answered it
        // before the story's next step could (a slow runner, 2026-11-26).
        const now =
          document.querySelector('section[aria-label="Tour step"][data-shown]')?.textContent ?? ""
        if (!now.includes(line) && (cue === undefined || !now.includes(cue))) return false
        const marked = clicked()[0]
        const wanted = new Set(subject().filter((each) => each !== undefined))
        // The subject, once a press can reach it: the tour may say its line with the window
        // mostly past the screen's edge (a slow macOS runner, 2026-11-25), and never moves the
        // view itself, so the person brings it with the box's eye, below.
        if (reachable(wanted)) return true
        if (marked && !wanted.has(marked) && !opened.has(marked)) {
          opened.add(marked)
          pressedAt = Date.now()
          // A window by its header, never into a pane's frame (see below).
          await page.elementLocator(headerOf(marked)).click()
          return false
        }
        // Nothing it marks in sight, the subject past the screen's edge, or what it marked
        // didn't bring the subject a while after its press (a pane loads its viewer first): the
        // box's eye brings it, once.
        const eye = showMe().query()
        if (
          eye instanceof HTMLElement &&
          !opened.has(eye) &&
          (!marked || Date.now() - pressedAt > 4_000)
        ) {
          opened.add(eye)
          // Not for as long as a click waits for a button that goes away with its box (a
          // question's takes it): what the box says now is read again after.
          await showMe()
            .click({ timeout: 3_000 })
            .catch(() => opened.delete(eye))
        }
        return false
      },
      { timeout: 20_000, interval: 400 },
    )
    .toBe(true)
    .catch((error: unknown) => {
      const first = clicked()[0]
      const where = !first
        ? "nothing was marked"
        : onScreen(headerOf(first))
          ? `what it marked was under ${named(coverOf(first))}`
          : "what it marked was off screen"
      throw new Error(`"${line}"'s subject never came within reach: ${where}`, { cause: error })
    })
  if (displaced) return
  // On its window's header, on the app's own page, as the tour counts a press anywhere in the
  // window: never in a page or a model's frame, which the tour hears by the app's page losing the
  // focus, which a page sharing its browser with other specs may not have to lose; and on no
  // control of the pane's (its tab's open button opens it over everything). Pressed again where
  // the press missed the window, or the caption hasn't moved on a while after it (a press the
  // tour can't have heard, as a person would press again): the tour keeps the first it hears.
  const presses: string[] = []
  const said = (what: string): void => {
    if (presses.at(-1) !== what) presses.push(what)
  }
  let landedAt: number | null = null
  const press = async (): Promise<void> => {
    const marked = reachable(new Set(subject().filter((each) => each !== undefined)))
    if (!marked) {
      const first = clicked()[0]
      said(
        first
          ? `its subject was out of reach (${onScreen(headerOf(first)) ? `under ${named(coverOf(first))}` : "off screen"})`
          : "nothing was marked",
      )
      return
    }
    const missed = await pressWindow(marked)
    said(missed ?? "landed in its window")
    if (missed === null) landedAt = Date.now()
  }
  await press()
  // The caption moves on once the step is done, which may wait on more than the press (the
  // teammates naming themselves), so as long as it took to say, and its hold after the touch.
  // A step that holds was pressed once alone before: a press the tour didn't hear left the game's
  // last step waiting, its closing card never coming (a loaded Windows runner, 2026-11-26).
  const deadline = Date.now() + 40_000 + holdMs
  for (;;) {
    if (!captionNow().includes(line)) return
    if (Date.now() > deadline)
      throw new Error(
        `The tour never moved on from "${line}": it says "${captionNow()}". Presses: ${presses.join("; ")}. Its run: ${runNow()}. Windows: ${[
          ...document.querySelectorAll<HTMLElement>(windowSelector),
        ]
          .map((each) => each.getAttribute("aria-label"))
          .join(", ")}`,
      )
    if (landedAt === null || Date.now() - landedAt > holdMs + 10_000) {
      // eslint-disable-next-line no-await-in-loop -- Each press waits for the one before.
      await press()
    }
    // eslint-disable-next-line no-await-in-loop -- The caption is read again after a while.
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

import { page, type Locator } from "vitest/browser"

import { expect } from "../test"
import { nameOf } from "./workspace"

// Vocabulary for the onboarding tour: its consent, its caption box and closing card, and what it
// marks on the page, which it draws on the page's own elements (`data-tour-look` where to look,
// `data-tour-click` what to press).

export const consent = (): Locator => page.getByRole("dialog", { name: "Take the tour" })
export const coach = (): Locator => page.getByRole("region", { name: "Tour step" })
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

/**
 * Plays a step that waits on the person, as they would: once its caption says `line`, presses
 * what opens its subject where the tour marks that first (the rail's button for a panel, a window
 * whose pane isn't showing yet), each once, then touches the subject itself, one of what
 * `subject` finds, and waits for the caption to move on (unless the step `stays` a while after,
 * as the game's last does).
 */
export const touchStep = async (
  line: string,
  subject: () => readonly (HTMLElement | undefined)[],
  { timeout = 40_000, stays = false }: { readonly timeout?: number; readonly stays?: boolean } = {},
): Promise<void> => {
  await coachSays(line, timeout)
  const opened = new Set<HTMLElement>()
  await expect
    .poll(
      async () => {
        const marked = clicked()[0]
        const wanted = subject().filter((each) => each !== undefined)
        if (marked && wanted.includes(marked)) return true
        if (marked && !opened.has(marked)) {
          opened.add(marked)
          await page.elementLocator(marked).click()
        }
        return false
      },
      { timeout: 20_000, interval: 400 },
    )
    .toBe(true)
  const marked = clicked()[0]!
  // In its middle, as into a page or a model; where its window takes the press there (on Canvas,
  // a window not selected takes it, to select itself), pressed all the same, as a person would.
  await page
    .elementLocator(marked)
    .click({ timeout: 3_000 })
    .catch(() => page.elementLocator(marked).click({ force: true }))
  if (stays) return
  await expect
    .poll(
      () =>
        document.querySelector('section[aria-label="Tour step"][data-shown]')?.textContent ?? "",
      { timeout: 15_000 },
    )
    .not.toContain(line)
}

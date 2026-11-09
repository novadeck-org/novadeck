import { beforeEach, expect } from "vitest"
import { userEvent, type Locator } from "vitest/browser"

const passThroughId = "specs-toasts-pass-through"

/**
 * Makes the toasts let the pointer through to what is under them, for every spec (the setup
 * file calls it before each one). The demo raises toasts of its own a moment after it opens,
 * and they stand 30 s over the header's right end and the windows' heads, so a spec's click
 * or hover there, on whatever it was about, timed out on a loaded runner whenever one landed
 * first (`.toast-layer … intercepts pointer events`, #784). They still show, read and take
 * the keyboard; a spec about pressing them asks for that with `pressableToasts`.
 */
export const toastsPassThrough = (): void => {
  if (document.getElementById(passThroughId)) return
  const style = document.createElement("style")
  style.id = passThroughId
  style.textContent = ".toast-layer, .toast-layer * { pointer-events: none !important; }"
  document.head.append(style)
}

/** For the specs of a file or block about pressing toasts: they take the pointer, as in the app. */
export const pressableToasts = (): void => {
  beforeEach(() => document.getElementById(passThroughId)?.remove())
}

// The toasts standing, the front one first, those leaving left out.
const standing = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.toast[data-state="open"]')].toSorted(
    (a, b) => Number(a.dataset.rank) - Number(b.dataset.rank),
  )

// A press on a toast within the stack's click grace (400 ms) of its landing or moving does
// nothing, and focus coming into the stack spreads it, which moves them all.
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 500))

/**
 * Closes every toast standing, as a person can from the keyboard: on the front one's ×, then
 * Enter. A toast stands 30 s over the header's right end and the windows' heads below it, so
 * a spec that means to press what is there, and not to test the toasts, takes them away
 * first. Focus goes back where it was as each one closes. A toast landing meanwhile moves the
 * rest, which can void a press, so it goes on from whichever is in front until none is left.
 */
export const closeToasts = async (): Promise<void> => {
  for (let tries = 0; tries < 30 && standing().length > 0; tries++) {
    standing()[0]!.querySelector<HTMLElement>(".toast-close")!.focus()
    // eslint-disable-next-line no-await-in-loop -- One toast after another, each settled first.
    await settled()
    // Its toast may have left meanwhile, giving focus back to what had it, which Enter would press.
    const close = document.activeElement
    if (!close?.matches('.toast[data-state="open"] .toast-close')) continue
    // eslint-disable-next-line no-await-in-loop -- As above.
    await userEvent.keyboard("{Enter}")
  }
  expect(standing()).toHaveLength(0)
}

/**
 * Clicks `target` with the pointer once the toasts are closed. The demo raises toasts of its
 * own a moment after it opens, so one can land between `closeToasts` and the click and take
 * it (`.toast-layer … intercepts pointer events`): a click that times out closes them again
 * and clicks again, so the press stays the pointer's, which a spec about a click needs.
 */
export const clickPastToasts = async (target: Locator, tries = 3): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- Each try closes what landed before it.
    await closeToasts()
    try {
      // eslint-disable-next-line no-await-in-loop -- As above.
      return await target.click({ timeout: 3_000 })
    } catch (error) {
      if (attempt >= tries) throw error
    }
  }
}

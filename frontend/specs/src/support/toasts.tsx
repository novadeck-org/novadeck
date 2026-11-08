import { expect } from "vitest"
import { userEvent } from "vitest/browser"

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
    // eslint-disable-next-line no-await-in-loop -- As above.
    await userEvent.keyboard("{Enter}")
  }
  expect(standing()).toHaveLength(0)
}

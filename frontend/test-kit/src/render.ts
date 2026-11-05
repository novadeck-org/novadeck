import { act, type ReactElement } from "react"
import { createRoot } from "react-dom/client"
import { onTestFinished } from "vitest"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

export type Rendered = {
  readonly container: HTMLElement
  readonly rerender: (element: ReactElement) => void
  readonly unmount: () => void
}

// Renders into a container appended to jsdom's body. Rendered inside a test, it unmounts
// once the test finishes; elsewhere, as in a `beforeAll`, call `unmount` when done. `unmount`
// may be called more than once.
export const render = (element: ReactElement): Rendered => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(element))
  let mounted = true
  const unmount = (): void => {
    if (!mounted) return
    mounted = false
    act(() => root.unmount())
    container.remove()
  }
  try {
    onTestFinished(unmount)
  } catch (error) {
    // Not inside a test: the caller unmounts.
    if (!(error instanceof Error && error.message.includes("can only be called inside a test")))
      throw error
  }
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount,
  }
}

// Lets the next animation frame run, inside act: what a component deferred to it, as Ark's
// layers look up their element a frame after opening, is done before the test goes on, and
// before an unmount leaves it nothing to find. A faked `requestAnimationFrame` never runs on
// its own, so it throws there rather than wait out the test's timeout.
export const nextFrame = (): Promise<void> => {
  if ("clock" in requestAnimationFrame)
    throw new Error(
      "nextFrame waits for a real frame, but requestAnimationFrame is faked: fake only the " +
        'timers the test needs, as vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }), ' +
        "or advance the frame with vi.advanceTimersToNextFrame().",
    )
  return act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

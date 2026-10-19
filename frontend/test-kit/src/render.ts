import { act, type ReactElement } from "react"
import { createRoot } from "react-dom/client"

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

export type Rendered = {
  readonly container: HTMLElement
  readonly rerender: (element: ReactElement) => void
  readonly unmount: () => void
}

// Renders into a detached-from-view container in jsdom; call `unmount` when done.
export const render = (element: ReactElement): Rendered => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(element))
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

// Lets the next animation frame run, inside act: what a component deferred to it, as Ark's
// layers look up their element a frame after opening, is done before the test goes on, and
// before an unmount leaves it nothing to find.
export const nextFrame = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

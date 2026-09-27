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

import { act, createElement, StrictMode, useEffect, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"

import type { Mount, Viewer, ViewerState } from "./index.js"
import { createKept } from "./kept.js"
import { useViewer } from "./react.js"

// React reads this to know act() is in charge of flushing.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A viewer that writes down what happens to it, its state the content it last had.
const calls: string[] = []
const mountText: Mount<string, Record<never, never>, Viewer<string> & { name: string }> = (
  _element,
  { content, label, saved },
) => {
  calls.push(`mount ${label} ${content} saved:${(saved as unknown as string) ?? "none"}`)
  let shown = content
  return {
    update: (next) => {
      calls.push(`update ${next}`)
      shown = next
    },
    state: () => shown as unknown as ViewerState,
    restore: () => undefined,
    jumpTo: () => undefined,
    focus: () => undefined,
    destroy: () => calls.push(`destroy ${label}`),
    name: label,
  }
}

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  calls.length = 0
  kept = createKept<ViewerState>(4)
})

let kept = createKept<ViewerState>(4)
let show: (shown: { id: string; content: string } | null) => void = () => undefined

const Host = () => {
  const [shown, setShown] = useState<{ id: string; content: string } | null>({
    id: "a",
    content: "first",
  })
  useEffect(() => {
    show = setShown
  }, [])
  return shown && createElement(Shown, shown)
}
const Shown = ({ id, content }: { id: string; content: string }) => {
  const { ref, viewer } = useViewer(mountText, { id, content, label: id, kept })
  return createElement("div", { ref, id, "data-viewer": viewer?.name })
}

const render = (strict = false) => {
  const root = createRoot(document.body.appendChild(document.createElement("div")))
  roots.push(root)
  act(() =>
    root.render(
      strict ? createElement(StrictMode, null, createElement(Host)) : createElement(Host),
    ),
  )
}

describe("a viewer in React", () => {
  it("mounts once, and passes new content on as an update", () => {
    render()
    act(() => show({ id: "a", content: "second" }))
    expect(calls).toEqual(["mount a first saved:none", "update second"])
  })

  it("keeps its state by id, and hands it to the next viewer of the same thing", () => {
    render()
    act(() => show({ id: "a", content: "edited" }))
    act(() => show({ id: "b", content: "other" }))
    act(() => show(null))
    act(() => show({ id: "a", content: "edited" }))
    expect(calls.filter((call) => !call.startsWith("update"))).toEqual([
      "mount a first saved:none",
      "destroy a",
      "mount b other saved:none",
      "destroy b",
      "mount a edited saved:edited",
    ])
  })

  it("mounts once under StrictMode, its doubled ref and effects coming before the element", () => {
    render(true)
    expect(calls).toEqual(["mount a first saved:none"])
  })

  it("mounts the next thing with its own content when the id and content change together", () => {
    render()
    act(() => show({ id: "b", content: "other" }))
    expect(calls).toEqual(["mount a first saved:none", "destroy a", "mount b other saved:none"])
  })

  it("hands over the viewer once it's mounted, and the next one for the next thing", () => {
    render()
    expect(document.querySelector("#a")?.getAttribute("data-viewer")).toBe("a")
    act(() => show({ id: "b", content: "other" }))
    expect(document.querySelector("#b")?.getAttribute("data-viewer")).toBe("b")
  })
})

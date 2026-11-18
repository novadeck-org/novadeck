import { render } from "@novadeck/test-kit/render"
import { Rows3 } from "lucide-react"
import { act, createElement, useState } from "react"
import { afterEach } from "vitest"

import type { PaneTool } from "../../../pane-row"
import { describe, expect, it } from "../../../test"
import { PreviewToolsSetter, usePreviewTools } from "./tools"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

// A preview with a tool that counts its clicks, its label saying how many.
const Counting = (): null => {
  const [count, setCount] = useState(0)
  usePreviewTools([
    { key: "count", icon: Rows3, label: `Count ${count}`, onClick: () => setCount(count + 1) },
  ])
  return null
}

const host = () => {
  const seen: (readonly PaneTool[])[] = []
  const rendered = render(
    createElement(
      PreviewToolsSetter,
      { value: (tools: readonly PaneTool[]) => seen.push(tools) },
      createElement(Counting),
    ),
  )
  unmounts.push(rendered.unmount)
  return { ...rendered, latest: () => seen.at(-1)!, seen }
}

describe("a preview's own tools", () => {
  it("reach the row, and call the preview's latest handler", () => {
    const { latest } = host()
    expect(latest().map((tool) => tool.label)).toEqual(["Count 0"])
    act(() => latest()[0]!.onClick!())
    expect(latest().map((tool) => tool.label)).toEqual(["Count 1"])
    act(() => latest()[0]!.onClick!())
    expect(latest().map((tool) => tool.label)).toEqual(["Count 2"])
  })

  it("leave the row as the preview goes", () => {
    const { latest, unmount } = host()
    unmounts.pop()
    act(() => unmount())
    expect(latest()).toEqual([])
  })
})

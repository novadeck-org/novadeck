import { render } from "@novadeck/test-kit/render"
import { Columns3, Rows3 } from "lucide-react"
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

// A preview whose one tool shows rows or columns by its icon alone.
const Flipping = (): null => {
  const [rows, setRows] = useState(true)
  usePreviewTools([
    { key: "by", icon: rows ? Rows3 : Columns3, label: "By", onClick: () => setRows(!rows) },
  ])
  return null
}

describe("a preview's own tools", () => {
  it("reach the row again when only a tool's icon changes", () => {
    const seen: (readonly PaneTool[])[] = []
    const rendered = render(
      createElement(
        PreviewToolsSetter,
        { value: (tools: readonly PaneTool[]) => seen.push(tools) },
        createElement(Flipping),
      ),
    )
    unmounts.push(rendered.unmount)
    expect(seen.at(-1)![0]!.icon).toBe(Rows3)
    act(() => seen.at(-1)![0]!.onClick!())
    expect(seen.at(-1)![0]!.icon).toBe(Columns3)
  })

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

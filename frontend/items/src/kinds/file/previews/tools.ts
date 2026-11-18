import { createContext, useContext, useLayoutEffect, useRef } from "react"

import type { PaneTool } from "../../../pane-row"

// A preview's own tools (a tree's collapse-all, say), which the pane's row shows before the
// switch to the source, in one group with it, so they fold together in a narrow pane. They go
// with the preview: switched to the source, the row holds the switch alone.

export const PreviewToolsSetter = createContext<((tools: readonly PaneTool[]) => void) | undefined>(
  undefined,
)

// What sets the row apart from one drawn before: a tool's handler is new each draw, and
// isn't.
const looksOf = (tools: readonly PaneTool[]): string =>
  JSON.stringify(tools.map(({ onClick: _onClick, icon: _icon, ...rest }) => rest))

// The preview's tools, in the row while it shows. Each draw may pass new handlers: the row
// calls the latest.
export const usePreviewTools = (tools: readonly PaneTool[]): void => {
  const set = useContext(PreviewToolsSetter)
  const latest = useRef(tools)
  useLayoutEffect(() => {
    latest.current = tools
  })
  const looks = looksOf(tools)
  // A tool's looks change the row; its handler is read as it's clicked.
  useLayoutEffect(() => {
    set?.(
      latest.current.map((tool): PaneTool => {
        if (!tool.onClick) return tool
        const click = (): void => latest.current.find((each) => each.key === tool.key)?.onClick?.()
        return { ...tool, onClick: click }
      }),
    )
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Its looks, not its handlers.
  }, [set, looks])
  useLayoutEffect(() => () => set?.([]), [set])
}

import { useReactFlow } from "@xyflow/react"
import { useCallback, useImperativeHandle, useState, type Ref } from "react"

import type { CanvasHandle, CanvasViewport, TerminalNode } from "./types"
import { createCanvasVisit } from "./visit"

export const useCanvasVisit = (handleRef: Ref<CanvasHandle>) => {
  const { setViewport } = useReactFlow<TerminalNode>()
  const [visit] = useState(createCanvasVisit)
  const animateVisit = useCallback(
    (flight: { viewport: CanvasViewport }) => {
      const run = (current: { viewport: CanvasViewport }): void => {
        void setViewport(current.viewport, {
          duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 350,
        }).then(
          (completed) => {
            const next = visit.finish(current, completed)
            if (next) run(next)
          },
          () => visit.finish(current, false),
        )
      }
      run(flight)
    },
    [setViewport, visit],
  )

  useImperativeHandle(
    handleRef,
    () => ({
      returnToOrigin: () => {
        if (!visit.visiting) return false
        const flight = visit.back()
        if (flight) animateVisit(flight)
        return true
      },
    }),
    [animateVisit, visit],
  )

  return { visit, animateVisit }
}

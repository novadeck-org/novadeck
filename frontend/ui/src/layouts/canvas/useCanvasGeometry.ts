import { useReactFlow, type OnNodesChange } from "@xyflow/react"
import { useCallback, useRef } from "react"

import { minimumSize, snap } from "./geometry"
import type { CanvasProps, TerminalNode } from "./types"
import type { CanvasPersistence } from "./useCanvasPersistence"

export const useCanvasGeometry = (
  { geometryRef, dirtyGeometry, resizing, commitGeometry }: CanvasPersistence,
  onSelect: CanvasProps["onSelect"],
  onWindowResize: CanvasProps["onWindowResize"],
) => {
  const { getNode, setNodes } = useReactFlow<TerminalNode>()
  const updateNode = useCallback(
    (id: string, update: (node: TerminalNode) => TerminalNode) => {
      setNodes((nodes) => nodes.map((item) => (item.id === id ? update(item) : item)))
    },
    [setNodes],
  )

  // Each resize's starting size, as its end would snap it, so a press that moves nothing
  // ends where it began.
  const started = useRef(new Map<string, { width: number; height: number }>())

  const beginResize = useCallback(
    (id: string) => {
      resizing.current.add(id)
      const currentNode = getNode(id)
      if (currentNode?.width && currentNode.height)
        started.current.set(id, {
          width: Math.max(minimumSize.width, snap(currentNode.width)),
          height: Math.max(minimumSize.height, snap(currentNode.height)),
        })
      if (currentNode) {
        geometryRef.current[id] = {
          ...geometryRef.current[id],
          position: currentNode.position,
          ...(currentNode.width ? { width: currentNode.width } : {}),
          ...(currentNode.height ? { height: currentNode.height } : {}),
        }
      }
      updateNode(id, (node) => ({ ...node, className: "resizing" }))
    },
    [getNode, updateNode, geometryRef, resizing],
  )

  const finishResize = useCallback(
    (id: string, width: number, height: number) => {
      if (!resizing.current.has(id)) return
      const currentNode = getNode(id)
      if (!currentNode) return
      resizing.current.delete(id)
      const before = started.current.get(id)
      started.current.delete(id)
      const next = {
        ...geometryRef.current[id],
        position: currentNode.position,
        width: Math.max(minimumSize.width, snap(width)),
        height: Math.max(minimumSize.height, snap(height)),
      }
      geometryRef.current[id] = next
      dirtyGeometry.current.add(id)
      updateNode(id, (current) => ({
        ...current,
        width: next.width,
        height: next.height,
        className: "",
      }))
      commitGeometry([id])
      // A press on the corner that changed nothing says nothing of the size wanted.
      if (before?.width !== next.width || before.height !== next.height)
        onWindowResize({ width: next.width, height: next.height })
    },
    [commitGeometry, getNode, updateNode, geometryRef, dirtyGeometry, resizing, onWindowResize],
  )

  const onNodesChange: OnNodesChange<TerminalNode> = useCallback(
    (changes) => {
      for (const change of changes) {
        if (change.type === "position" && change.position && !resizing.current.has(change.id)) {
          if (change.dragging) {
            geometryRef.current[change.id] = {
              ...geometryRef.current[change.id],
              position: change.position,
            }
            dirtyGeometry.current.add(change.id)
          } else if (dirtyGeometry.current.has(change.id)) {
            const position = { x: snap(change.position.x), y: snap(change.position.y) }
            geometryRef.current[change.id] = { ...geometryRef.current[change.id], position }
            updateNode(change.id, (node) => ({ ...node, position }))
            commitGeometry([change.id])
          }
        }
        if (change.type === "dimensions" && change.dimensions && resizing.current.has(change.id)) {
          const current = geometryRef.current[change.id]
          geometryRef.current[change.id] = {
            ...current,
            position: current?.position ?? getNode(change.id)?.position ?? { x: 0, y: 0 },
            width: change.dimensions.width,
            height: change.dimensions.height,
          }
          dirtyGeometry.current.add(change.id)
          if (change.resizing === false)
            finishResize(change.id, change.dimensions.width, change.dimensions.height)
        }
        if (change.type === "select" && change.selected) onSelect(change.id)
      }
    },
    [
      commitGeometry,
      finishResize,
      getNode,
      onSelect,
      updateNode,
      geometryRef,
      dirtyGeometry,
      resizing,
    ],
  )

  return { beginResize, finishResize, onNodesChange }
}

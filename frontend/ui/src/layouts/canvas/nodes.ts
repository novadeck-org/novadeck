import type { TerminalNode } from "./types"

// Whether every field the canvas sets on a node is as the node already has it. XYFlow's own
// fields on the node it holds, as its measured size, aren't the canvas's and don't count.
const sameNode = (current: TerminalNode, next: TerminalNode): boolean =>
  Object.entries(next).every(([key, value]) => {
    const held: unknown = current[key as keyof TerminalNode]
    if (key === "position")
      return current.position.x === next.position.x && current.position.y === next.position.y
    if (key === "data")
      return Object.entries(next.data).every(([field, each]) =>
        Object.is(current.data[field as keyof TerminalNode["data"]], each),
      )
    return Object.is(held, value)
  })

/**
 * The nodes as the canvas places them: `next`, keeping each node of `previous` that it leaves
 * as it was, and `previous` itself when it changes none. Any terminal's news places the
 * windows again, and a node XYFlow is handed afresh is drawn again, so with many windows a
 * status change would otherwise redraw every one.
 */
export const keepUnchanged = (
  previous: readonly TerminalNode[],
  next: readonly TerminalNode[],
): TerminalNode[] => {
  const held = new Map(previous.map((node) => [node.id, node]))
  const kept = next.map((node) => {
    const current = held.get(node.id)
    return current && sameNode(current, node) ? current : node
  })
  return kept.length === previous.length && kept.every((node, index) => node === previous[index])
    ? (previous as TerminalNode[])
    : kept
}

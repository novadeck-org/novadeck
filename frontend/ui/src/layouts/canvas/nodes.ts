import type { TerminalNode } from "./types"

// The fields XYFlow sets on a node it holds, never the canvas: they don't count as a change.
const xyflowOwn = new Set(["measured", "dragging", "resizing"])

// A field as the canvas means it: a class cleared to "" is no class.
const meant = (key: string, value: unknown): unknown =>
  key === "className" && value === "" ? undefined : value

// Whether every field the canvas sets on a node is as the node already has it, a field it
// no longer sets included.
const sameNode = (current: TerminalNode, next: TerminalNode): boolean => {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)])
  return [...keys].every((key) => {
    if (xyflowOwn.has(key)) return true
    if (key === "position")
      return current.position.x === next.position.x && current.position.y === next.position.y
    if (key === "data") {
      const fields = new Set([...Object.keys(current.data), ...Object.keys(next.data)])
      return [...fields].every((field) =>
        Object.is(
          current.data[field as keyof TerminalNode["data"]],
          next.data[field as keyof TerminalNode["data"]],
        ),
      )
    }
    return Object.is(
      meant(key, current[key as keyof TerminalNode]),
      meant(key, next[key as keyof TerminalNode]),
    )
  })
}

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

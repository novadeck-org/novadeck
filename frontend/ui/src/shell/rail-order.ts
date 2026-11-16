import { panelNamed, sidebarPanels, type SidebarPanel } from "@novadeck/core/types"

// The rail's panels in the order the person left them, from what was stored: the ones they
// placed, as they placed them (a panel stored under a former id in its place), then any never
// placed (one new to the rail), in its own order.
export const railOrder = (stored: readonly string[]): readonly SidebarPanel[] => {
  const placed = stored
    .map(panelNamed)
    .filter(
      (each, index, all): each is SidebarPanel => each !== undefined && all.indexOf(each) === index,
    )
  return [...placed, ...sidebarPanels.filter((panel) => !placed.includes(panel))]
}

// The order with the panel shown at `from` moved to `to` among those shown; a panel this
// backend doesn't show keeps its place, for a backend that does.
export const movedPanel = (
  order: readonly SidebarPanel[],
  shown: readonly SidebarPanel[],
  from: number,
  to: number,
): readonly SidebarPanel[] => {
  const moved = [...shown]
  const [panel] = moved.splice(from, 1)
  if (panel === undefined) return order
  moved.splice(to, 0, panel)
  let next = 0
  return order.map((each) => (shown.includes(each) ? (moved[next++] ?? each) : each))
}

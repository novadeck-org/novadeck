import { Avatar } from "@novadeck/items/Avatar"
import { useStore, ViewportPortal, type ReactFlowState } from "@xyflow/react"
import { useCallback, useMemo } from "react"

import type { TerminalNode } from "./types"

// Agent avatars (experimental) on a zoomed-out Canvas: each window's critter as it grows,
// a twin of its header's, on the header critter's place. Past `avatarGrowZoom` it takes over
// from that critter and grows from its lower right corner, up and to the left, past the
// window's corner and clear of its title (canvas.css; the growth is `avatarGrowAt`). The
// twins share one layer in the viewport's world above every window, so a neighbour's
// corner never covers one: a node's own stacking would let it. Mounted only while some
// window has a critter, so that without one no move renders anything.
export const CanvasAvatars = ({
  avatars,
}: {
  // Each window's handle, by its id, for the windows that draw a critter.
  avatars: ReadonlyMap<string, string>
}): React.JSX.Element | null => (avatars.size ? <Twins avatars={avatars} /> : null)

type Placed = [
  id: string,
  x: number,
  y: number,
  hiding: boolean,
  selected: boolean,
  preview: boolean,
  team: string,
  dragging: boolean,
]

const Twins = ({ avatars }: { avatars: ReadonlyMap<string, string> }): React.JSX.Element => {
  const ids = useMemo(() => [...avatars.keys()], [avatars])
  // Where each window is and how it stands, as one string, so that this renders only when
  // one moves or changes, never on a pan or zoom: those reach the twins through CSS.
  const placed = useStore(
    useCallback(
      (state: ReactFlowState) =>
        JSON.stringify(
          ids.flatMap((id): Placed[] => {
            const node = state.nodeLookup.get(id)
            if (!node || node.hidden) return []
            const data = node.data as Partial<TerminalNode["data"]>
            const { x, y } = node.internals.positionAbsolute
            return [
              [
                id,
                x,
                y,
                Boolean(data.hiding),
                Boolean(node.selected),
                Boolean(data.preview),
                data.team ?? "",
                Boolean(node.dragging),
              ],
            ]
          }),
        ),
      [ids],
    ),
  )
  return (
    <ViewportPortal>
      <div className="canvas-avatars" aria-hidden="true">
        {(JSON.parse(placed) as Placed[]).map(
          ([id, x, y, hiding, selected, preview, team, dragging]) => (
            <div
              key={id}
              className="canvas-avatar-at"
              data-node={id}
              data-dragging={dragging || undefined}
              style={{ transform: `translate(${x}px, ${y}px)` }}
            >
              <span
                className="canvas-avatar"
                data-hiding={hiding || undefined}
                data-selected={selected || undefined}
                data-preview={preview || undefined}
                data-team={team || undefined}
              >
                <Avatar handle={avatars.get(id)!} size={16} />
              </span>
            </div>
          ),
        )}
      </div>
    </ViewportPortal>
  )
}

import type { ChangeLayer } from "@novadeck/core/items"

import { Counts } from "./Parts"
import { railOf } from "./selection"
import { timeLabel } from "./time"

// The change's layers, the uncommitted work and each commit since main, newest first. A
// selected row has a rail on its left edge, joined to the selected rows next to it.

export const shortHash = (layer: ChangeLayer): string =>
  layer.kind === "commit" ? layer.id.slice(0, 7) : ""

export const LayerList = ({
  layers,
  selected,
  onPick,
}: {
  layers: readonly ChangeLayer[]
  selected: ReadonlySet<string>
  onPick: (id: string) => void
}): React.JSX.Element => {
  const rails = railOf(
    layers.map((layer) => layer.id),
    selected,
  )
  return (
    <div role="listbox" aria-multiselectable="true" aria-label="Layers" className="changes-layers">
      {layers.map((layer, at) => {
        const rail = rails[at]!
        const clean = layer.kind === "uncommitted" && layer.files.length === 0
        return (
          <div
            key={layer.id}
            role="option"
            tabIndex={0}
            aria-selected={rail.on}
            className="changes-layer"
            data-id={layer.id}
            data-kind={layer.kind}
            data-on={rail.on || undefined}
            data-start={rail.start || undefined}
            data-end={rail.end || undefined}
            onClick={() => onPick(layer.id)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              onPick(layer.id)
            }}
          >
            {/* The work not committed yet has no hash yet: dots hold its place, unread. */}
            <code className="changes-sha">
              {layer.kind === "uncommitted" ? <span aria-hidden>·······</span> : shortHash(layer)}
            </code>
            {/* The subject's cell, so a merge's note sits after it and the columns hold. */}
            <span className="changes-subject-cell">
              <span className="changes-subject" title={layer.subject || undefined}>
                {layer.kind === "uncommitted" ? "Uncommitted" : layer.subject || "(no message)"}
              </span>
              {layer.firstParent && (
                <span
                  className="changes-layer-note"
                  title="This git can't merge in memory, so what the merge brought in from main shows as its work"
                >
                  merge, against its first parent
                </span>
              )}
            </span>
            <span className="changes-time">{timeLabel(layer.time)}</span>
            {clean ? (
              <span className="changes-pm changes-clean">nothing</span>
            ) : (
              <Counts added={layer.added} removed={layer.removed} />
            )}
          </div>
        )
      })}
    </div>
  )
}

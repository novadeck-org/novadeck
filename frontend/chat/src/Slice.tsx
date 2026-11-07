import type { ChatSlice } from "@novadeck/core/conversation"
import { sliceRunStyle } from "@novadeck/core/conversation/slice"

// The terminal's own rows, live, as they are drawn: as wide as its columns, so a narrower
// chat scrolls them. Plain for now; the look comes with the chat's redesign.
export const Slice = ({ slice }: { readonly slice: ChatSlice }): React.JSX.Element => (
  <pre
    className="chat-raw chat-slice nodrag nopan nowheel"
    tabIndex={0}
    aria-label="The terminal's own rows"
    style={{ width: `${slice.columns}ch`, maxWidth: "100%" }}
  >
    {slice.rows.map((row, at) => (
      // A row has no identity but its place on the screen.
      // eslint-disable-next-line react/no-array-index-key
      <div key={at}>
        {row.length === 0
          ? " "
          : row.map((run, part) => (
              // eslint-disable-next-line react/no-array-index-key
              <span key={part} style={sliceRunStyle(run)}>
                {run.text}
              </span>
            ))}
      </div>
    ))}
  </pre>
)

import { Fragment } from "react"

import { mentionsIn, type Mention } from "./mentions"

// A handle in the hue of the agent it names (see `markdown.css` for the hook).
export const MentionSpan = ({
  text,
  hue,
}: {
  readonly text: string
  readonly hue: number
}): React.JSX.Element => (
  <span className="markdown-mention" data-hue={hue}>
    {text}
  </span>
)

// Plain words, the handles in them of agents the app knows drawn in their hues. The text is
// unchanged; with no `mention`, or no handle known, it is the text alone.
export const MentionedText = ({
  text,
  mention,
}: {
  readonly text: string
  readonly mention?: Mention | undefined
}): React.JSX.Element => {
  const parts = mention && mentionsIn(text, mention)
  if (!parts) return <>{text}</>
  return (
    <>
      {parts.map((part, index) =>
        part.t === "mention" ? (
          // oxlint-disable-next-line react/no-array-index-key -- The parts are cut from text; they never reorder.
          <MentionSpan key={index} text={part.text} hue={part.hue} />
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- As above.
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}

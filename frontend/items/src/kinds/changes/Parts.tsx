import type { Part } from "./labels"

/** Where each of some texts starts when they run one after the other: what keys a piece of a line. */
export const startsOf = (texts: readonly string[]): number[] =>
  texts.reduce<number[]>(
    (starts, text, at) => [...starts, (starts[at - 1] ?? 0) + (texts[at - 1]?.length ?? 0)],
    [],
  )

// A label's parts, each in the voice its kind has: the kind word quiet, a name in code, the
// tokens an edit replaced as was and now. A part is keyed by where its text starts.
export const Parts = ({ parts }: { parts: readonly Part[] }): React.JSX.Element => {
  const starts = startsOf(parts.map((part) => part.text))
  return (
    <>
      {parts.map((part, at) => {
        const key = starts[at]
        if (part.kind === "plain") return part.text
        if (part.kind === "word")
          return (
            <span key={key} className="changes-word">
              {part.text}
            </span>
          )
        if (part.kind === "code") return <code key={key}>{part.text}</code>
        return (
          <span key={key} className={part.kind === "was" ? "changes-was" : "changes-now"}>
            {part.text}
          </span>
        )
      })}
    </>
  )
}

// Lines added and removed, and, apart, those that only changed whitespace.
export const Counts = ({
  added,
  removed,
  reindented = 0,
  className = "changes-pm",
}: {
  added: number
  removed: number
  reindented?: number
  className?: string
}): React.JSX.Element => (
  <span className={className}>
    <span className="changes-add">+{added}</span> <span className="changes-rem">−{removed}</span>
    {reindented > 0 && <span className="changes-re"> {reindented} re-indented</span>}
  </span>
)

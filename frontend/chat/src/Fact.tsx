import { span, timeOfDay, useNow } from "./facts"

// A fact at a row's right edge, in the work's size, dim. It is for the eye: the row's own words
// say what a screen reader needs.
// - live: a clock still running, a step brighter.
// - hover: shown only while the row is pointed at or holds focus.
// - keep: stays where the chat is narrow, being on a line of its own.
// - tone: bad is a failure's, in the danger colour.
export const Fact = ({
  live,
  hover,
  keep,
  tone,
  children,
}: {
  readonly live?: boolean
  readonly hover?: boolean
  readonly keep?: boolean
  readonly tone?: "bad"
  readonly children: React.ReactNode
}): React.JSX.Element => (
  <span
    className="chat-fact"
    data-live={live || undefined}
    data-hover={hover || undefined}
    data-keep={keep || undefined}
    data-tone={tone}
    aria-hidden
  >
    {children}
  </span>
)

// A clock running since `since`, to the second.
export const Since = ({
  since,
  before = "",
  after = "",
}: {
  readonly since: number
  readonly before?: string
  readonly after?: string
}): React.JSX.Element => (
  <>
    {before}
    {span(useNow() - since)}
    {after}
  </>
)

// A time of day, where the record has one: shown on hover unless it's more than that.
export const TimeFact = ({
  at,
  hover = false,
}: {
  readonly at: number | null
  readonly hover?: boolean
}): React.JSX.Element | null => (at === null ? null : <Fact hover={hover}>{timeOfDay(at)}</Fact>)

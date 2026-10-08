import type { AgentStats } from "../model/agent-usage"

const radius = 5.5
const circumference = 2 * Math.PI * radius

// How full a context is, as a ring that fills clockwise from the top.
const ContextRing = ({ share }: { share: number }): React.JSX.Element => (
  <svg className="terminal-stats-ring" viewBox="0 0 14 14" aria-hidden>
    <circle className="terminal-stats-ring-track" cx="7" cy="7" r={radius} />
    <circle
      className="terminal-stats-ring-fill"
      cx="7"
      cy="7"
      r={radius}
      strokeDasharray={`${(circumference * share).toFixed(2)} ${circumference.toFixed(2)}`}
    />
  </svg>
)

// What the agent runs on, floating over its terminal's top right: a ring for how full its
// context is, faint until it's hovered or focused, when it comes up and two groups of
// words slide out leftwards beside it (window.css), each a value with its detail in
// brackets: the model and its
// effort, "Opus 5.5 (high)", and the context's share and tokens, "62% (124k/200k)". Where
// its harness doesn't say the context's capacity there's no share to draw, so the tokens
// it holds stand in for the ring; without a context at all, the model shows as it is.
export const WindowStats = ({ stats }: { stats: AgentStats }): React.JSX.Element => {
  const { model, effort, context } = stats
  const runsOn = model && effort ? `${model} (${effort})` : (model ?? effort ?? "")
  const used = context && context.share !== null ? `${context.label} (${context.tokens})` : ""
  const said = [[model, effort].filter(Boolean).join(" · "), context?.detail]
    .filter(Boolean)
    .join(", ")
  return (
    <span
      // Its own, not the terminal's or the canvas's: a press here neither selects text in
      // the terminal nor drags or pans the canvas.
      className="terminal-stats flex shrink-0 items-center nodrag nopan"
      data-ring={context ? "" : undefined}
      role="img"
      aria-label={said}
      // Focusable where there is more to show, which a touch screen reveals by a tap.
      tabIndex={context ? 0 : undefined}
    >
      {(runsOn || used) && (
        <span className="terminal-stats-runs" aria-hidden>
          {runsOn && <span>{runsOn}</span>}
          {used && <span>{used}</span>}
        </span>
      )}
      {context &&
        (context.share !== null ? (
          <ContextRing share={context.share} />
        ) : (
          <span aria-hidden>{context.tokens}</span>
        ))}
    </span>
  )
}

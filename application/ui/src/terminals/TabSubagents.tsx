import type { SubagentMarks } from "../model/agent-subagents"

// How many marks a tab's line shows before it counts the rest, and how many rows its
// branches list before they do.
const lineMarks = 4
const branchRows = 3

// The places of the first `count` marks: a mark is where it stands, as subagents the
// harness only counts have nothing else to tell them apart.
const places = (count: number) => Array.from({ length: count }, (_, place) => place)

// Each mark's spinner starts at its own frame, so marks side by side don't tick as one.
const markDelay = (index: number) => ({ animationDelay: `-${((index + 1) * 260) % 800}ms` })

// A spinner while the agent works on, as its phase glyph spins; a hollow mark while what
// it started runs on without it (tabs.css).
const Mark = ({ index }: { index: number }) => (
  <span
    className="terminal-tab-subagent inline-block w-[1ch] shrink-0 text-center"
    style={markDelay(index)}
  />
)

// The subagents on the tab's line, after its program: a mark for each, past a rule, the
// rest counted. They fold away while the rows under the line show them (tabs.css). The
// tab's description says them in words.
export const SubagentLine = ({ marks }: { marks: SubagentMarks }): React.JSX.Element => {
  const { length } = marks.kinds
  return (
    <span aria-hidden className="terminal-tab-subagents grid shrink-0">
      <span className="flex min-w-0 items-center overflow-hidden">
        <span className="terminal-tab-subagents-rule mr-0.5">│</span>
        {places(Math.min(length, lineMarks)).map((place) => (
          <Mark key={place} index={place} />
        ))}
        {length > lineMarks && (
          <span className="terminal-tab-subagents-more ml-0.5">+{length - lineMarks}</span>
        )}
      </span>
    </span>
  )
}

// The subagents under the tab's line, one row each, as a tree from the agent: its mark
// and kind, as the tab's line has its phase and program; past three rows, the rest
// counted on the last. Every tab whose agent runs subagents holds them; they unfold
// while it's selected (tabs.css), the gap above them folding with them.
export const SubagentBranches = ({ marks }: { marks: SubagentMarks }): React.JSX.Element => {
  const { kinds } = marks
  const shown = kinds.length > branchRows ? kinds.slice(0, branchRows - 1) : kinds
  const rest = kinds.length - shown.length
  const rows = [...shown.map((kind) => kind || "subagent"), ...(rest > 0 ? [`+${rest} more`] : [])]
  return (
    <span aria-hidden className="terminal-tab-branches -mt-1 grid min-w-0">
      <span className="terminal-tab-branches-fold min-h-0 overflow-hidden">
        <span className="flex min-w-0 flex-col pt-1 text-caption leading-[18px]">
          {places(rows.length).map((place) => (
            <span key={place} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
              <span className="terminal-tab-branch shrink-0">
                {place === rows.length - 1 ? "└" : "├"}
              </span>
              {place < shown.length ? (
                <Mark index={place} />
              ) : (
                <span className="inline-block w-[1ch] shrink-0" />
              )}
              <span className="truncate">{rows[place]}</span>
            </span>
          ))}
        </span>
      </span>
    </span>
  )
}

import type { AgentShell } from "@novadeck/core/types"

import { Fact, Since } from "./Fact"

// The shells that still run, oldest first: a shell that ended has no line.
export const runningShells = (shells: readonly AgentShell[] | undefined): readonly AgentShell[] =>
  shells?.filter(({ exit }) => exit === null) ?? []

// From this many shells on, the lines fold into one.
const foldAt = 3

// How many lines the shells take: three or more are one while folded, and a line over them
// once open.
export const shellRows = (shells: readonly AgentShell[], open: boolean): number =>
  shells.length < foldAt ? shells.length : open ? shells.length + 1 : 1

// The start of a command, for the folded line: its first two words, cut to a line's share.
export const shortCommand = (command: string): string => {
  const words = command.trim().split(/\s+/).slice(0, 2).join(" ")
  return words.length > 24 ? `${words.slice(0, 23)}…` : words
}

const Line = ({ shell }: { readonly shell: AgentShell }): React.JSX.Element => (
  <div className="chat-shell">
    <span className="chat-shell-mark" aria-hidden>
      $
    </span>
    <span className="chat-shell-command" title={shell.command}>
      {shell.command}
    </span>
    <Fact live keep>
      <Since since={shell.since} />
    </Fact>
  </div>
)

// A line for each background shell the agent has running, under the working line, which stay
// after the turn until the shell ends. Three or more fold into one line until opened.
export const ShellLines = ({
  shells,
  open,
  onOpen,
}: {
  readonly shells: readonly AgentShell[]
  readonly open: boolean
  readonly onOpen: (open: boolean) => void
}): React.JSX.Element | null => {
  if (shells.length === 0) return null
  const folded = shells.length >= foldAt
  return (
    <div className="chat-shells" role="group" aria-label="Background shells">
      {folded && (
        <div className="chat-shell" data-fold>
          <span className="chat-shell-mark" aria-hidden>
            $
          </span>
          <span className="chat-shell-count">{shells.length} shells</span>
          {!open && (
            <span className="chat-shell-command">
              {shells.map(({ command }) => shortCommand(command)).join(", ")}
            </span>
          )}
          <button
            type="button"
            className="chat-shell-toggle nodrag nopan"
            aria-expanded={open}
            onClick={() => onOpen(!open)}
          >
            {open ? "hide" : "show"}
          </button>
        </div>
      )}
      {(!folded || open) && shells.map((shell) => <Line key={shell.id} shell={shell} />)}
    </div>
  )
}

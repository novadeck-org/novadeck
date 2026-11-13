import { shellStateOf } from "@novadeck/core/agents/shells"
import type { AgentShell } from "@novadeck/core/types"
import { useEffect, useSyncExternalStore } from "react"

import { Fact, Since } from "./Fact"

// The shells that have a line, oldest first: those that still run, and those that failed,
// which stay until the agent forgets them. A shell that ended quietly has none.
export const listedShells = (shells: readonly AgentShell[] | undefined): readonly AgentShell[] =>
  shells?.filter((shell) => ["running", "failed"].includes(shellStateOf(shell))) ?? []

// Where the last line of each shell's output comes from, by the shell's id: followed while
// the lines need it, read as an external store whose value stays the same until a last line
// changes, so a log that grows under them re-renders nothing else.
export type ShellTailsSource = {
  readonly watch: () => () => void
  readonly subscribe: (on: () => void) => () => void
  readonly snapshot: () => Readonly<Record<string, string>>
}

const noTails: Readonly<Record<string, string>> = {}
const noSubscribe = (): (() => void) => () => {}
const noSnapshot = (): Readonly<Record<string, string>> => noTails

// The last lines of the shells' output, followed only while a listed shell has an output file.
const useTails = (
  source: ShellTailsSource | undefined,
  shells: readonly AgentShell[],
): Readonly<Record<string, string>> => {
  const watching = shells.some(({ output }) => output !== undefined)
  useEffect(() => (source && watching ? source.watch() : undefined), [source, watching])
  return useSyncExternalStore(source?.subscribe ?? noSubscribe, source?.snapshot ?? noSnapshot)
}

// From this many shells on, the lines fold into one.
const foldAt = 3

// The start of a command, for the folded line: its first two words, cut to a line's share.
export const shortCommand = (command: string): string => {
  const words = command.trim().split(/\s+/).slice(0, 2).join(" ")
  return words.length > 24 ? `${words.slice(0, 23)}…` : words
}

// A shell's line: its command, its clock or how it failed, and under them the last line of its
// output where Novadeck has it. Where the pane can show its output, the line opens it.
const Line = ({
  shell,
  last,
  onOpen,
}: {
  readonly shell: AgentShell
  readonly last: string | undefined
  readonly onOpen: ((shellId: string) => void) | undefined
}): React.JSX.Element => {
  const failed = shellStateOf(shell) === "failed"
  const open = onOpen && (() => onOpen(shell.id))
  return (
    <>
      <div className="chat-shell" data-output={open ? "" : undefined}>
        <span className="chat-shell-mark" aria-hidden>
          $
        </span>
        {open ? (
          <button
            type="button"
            className="chat-shell-command nodrag nopan"
            title={shell.command}
            aria-label={`Show the output of ${shell.command}${failed ? `, exited ${shell.exit!.code}` : ""}`}
            onClick={open}
          >
            {shell.command}
          </button>
        ) : (
          <span className="chat-shell-command" title={shell.command}>
            {shell.command}
          </span>
        )}
        {failed ? (
          <Fact keep tone="bad">
            exited {shell.exit!.code}
          </Fact>
        ) : (
          <Fact live keep>
            <Since since={shell.since} />
          </Fact>
        )}
      </div>
      {last !== undefined && (
        // Pointing at it is another way to the output the command's button opens: the keyboard
        // and screen readers have that button.
        <div
          className="chat-shell-last"
          data-tone={failed ? "bad" : undefined}
          data-output={open ? "" : undefined}
          onClick={open}
        >
          {last}
        </div>
      )}
    </>
  )
}

// A line for each background shell the agent has running or failed, under the working line,
// which stay after the turn until the shell ends. Three or more fold into one line until opened.
// `tails` gives the last line of each shell's output; `onShell` opens a shell's output.
export const ShellLines = ({
  shells,
  tails,
  onShell,
  open,
  onOpen,
}: {
  readonly shells: readonly AgentShell[]
  readonly tails: ShellTailsSource | undefined
  readonly onShell: ((shellId: string) => void) | undefined
  readonly open: boolean
  readonly onOpen: (open: boolean) => void
}): React.JSX.Element | null => {
  const lasts = useTails(tails, shells)
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
      {(!folded || open) &&
        shells.map((shell) => (
          <Line key={shell.id} shell={shell} last={lasts[shell.id]} onOpen={onShell} />
        ))}
    </div>
  )
}

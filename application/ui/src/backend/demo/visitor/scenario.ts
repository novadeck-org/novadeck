import { activeProject, activeSession } from "../../../model/state"
import type { TerminalMetadata, Workspace } from "../../../model/types"
import type { TerminalKey } from "../../port"
import type { DemoAgentVerbs } from "../agent-link"
import { terminalOf } from "../debug/terminals"

// One step of the visitor demo's story, told on the agent verbs alone: what the person
// sees follows from them, as from a real agent.
export type Beat = {
  // How long after the beat before it played, or was skipped, this one is due.
  readonly after: number
  // The terminals it may act on, in order of preference: the first the person isn't using.
  readonly on: readonly TerminalKey[]
  readonly play: (
    verbs: DemoAgentVerbs,
    key: TerminalKey,
    terminal: TerminalMetadata | undefined,
  ) => void
}

// What the scenario needs of the demo around it.
export type Stage = {
  readonly verbs: DemoAgentVerbs
  readonly workspace: () => Workspace | undefined
  // Whether a turn the demo started in the terminal still runs, as the person's prompt does.
  readonly working: (key: TerminalKey) => boolean
  // Whether the person has been still for a while: no click, key or scroll lately.
  readonly still: () => boolean
}

// How long a due beat waits for the person to be still before it looks again.
export const stillCheckMs = 1000

// The terminal the person is on: the selection of the session on screen.
export const selectedKey = (workspace: Workspace | undefined): TerminalKey | undefined => {
  const session = workspace && activeSession(workspace)
  const project = workspace && activeProject(workspace)
  if (!session || !project || !session.state.selected) return undefined
  return {
    projectId: project.id,
    workspaceSessionId: session.id,
    terminalId: session.state.selected,
  }
}

const same = (a: TerminalKey, b: TerminalKey | undefined): boolean =>
  a.projectId === b?.projectId &&
  a.workspaceSessionId === b.workspaceSessionId &&
  a.terminalId === b.terminalId

// Plays the beats one after another, each at its time. A beat never acts on the terminal
// the person has selected, where they may be typing, nor on one whose turn they started,
// so it moves to its next candidate or, with none, is skipped; and while the person
// clicks, types or scrolls it waits for them to be still. Returns the stop.
export const playScenario = (beats: readonly Beat[], stage: Stage): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const next = (index: number): void => {
    const beat = beats[index]
    if (!beat) return
    timer = setTimeout(function due() {
      if (!stage.still()) {
        timer = setTimeout(due, stillCheckMs)
        return
      }
      const workspace = stage.workspace()
      const selected = selectedKey(workspace)
      const key = beat.on.find(
        (each) =>
          terminalOf(workspace, each) !== undefined &&
          !same(each, selected) &&
          !stage.working(each),
      )
      if (key) beat.play(stage.verbs, key, terminalOf(workspace, key))
      next(index + 1)
    }, beat.after)
  }
  next(0)
  return () => clearTimeout(timer)
}

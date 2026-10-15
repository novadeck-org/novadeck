import type { Backend } from "../../port"
import { createDemoEngine } from "../engine"
import { demoBackend, withConversations } from "../index"
import { agentTranscripts } from "../transcripts"
import { demoTurns } from "../turns"
import { visitorSeed } from "./seed"
import { visitorStory } from "./story"

// How long a visitor's agent works on a turn, in milliseconds: long enough to read as work.
const visitorTurnMs = 4000

// The demo for a website's visitors: a tidy desk (see `visitorSeed`) whose agents move on
// only as the visitor answers them (see `visitorStory`), and without what a browser page
// can't offer: the debug panel, the chat view, connecting agents, voice, murmur, notices,
// updates and a version. The terminals' screens read the agents' conversations. What it
// returns is listed field by field, so nothing added to the agents demo reaches a public
// page unasked. Specs shorten the turns and the wait before Codex asks.
export const visitorDemo = ({
  turnMs = visitorTurnMs,
  nudgeMs,
}: { readonly turnMs?: number; readonly nudgeMs?: number } = {}): Backend => {
  const now = Date.now()
  const turns = demoTurns(turnMs)
  const story = visitorStory(agentTranscripts(now), turns, nudgeMs)
  const base = demoBackend(createDemoEngine(), false, undefined, undefined, visitorSeed(now))
  const backend = story.wrap(withConversations(base, story.transcripts, turns))
  return {
    seed: backend.seed,
    newTerminal: backend.newTerminal,
    commit: backend.commit,
    TerminalSurface: backend.TerminalSurface,
    ...(backend.companions && { companions: backend.companions }),
    ...(backend.start && { start: backend.start }),
    visitor: true,
  }
}

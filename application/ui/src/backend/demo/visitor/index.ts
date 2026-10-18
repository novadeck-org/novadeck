import type { Backend } from "../../port"
import { createDemoEngine } from "../engine"
import { demoBackend, surfaceOf, withConversations } from "../index"
import { lessMotion, stillRequested } from "../motion"
import { agentTranscripts } from "../transcripts"
import { demoTurns } from "../turns"
import { visitorAmbient } from "./ambient"
import { visitorSeed, visitorTelemetry } from "./seed"
import { visitorReadingMs, visitorStory } from "./story"

// How long a visitor's agent works on a turn, in milliseconds: long enough to read as work.
const visitorTurnMs = 4000

// The demo for a website's visitors: a tidy desk (see `visitorSeed`) whose agents move on
// only as the visitor answers them (see `visitorStory`), with a little going on by itself
// meanwhile (see `visitorAmbient`), and without what a browser page
// can't offer: the debug panel, the chat view, connecting agents, voice, murmur, notices,
// updates and a version. The terminals' screens read the agents' conversations. What it
// returns is listed field by field, so nothing added to the agents demo reaches a public
// page unasked. Specs shorten the turns, the wait before Codex asks and the time Claude Code
// reads before its plan, which none of them wait for by default (`readingMs: 0`), and
// leave out what goes on by itself.
export const visitorDemo = ({
  turnMs = visitorTurnMs,
  nudgeMs,
  readingMs = visitorReadingMs,
  ambient = true,
}: {
  readonly turnMs?: number
  readonly nudgeMs?: number
  readonly readingMs?: number
  readonly ambient?: boolean
} = {}): Backend => {
  const now = Date.now()
  const turns = demoTurns(turnMs)
  turns.telemetry.update(() => visitorTelemetry(now))
  // Asked for less motion, Claude Code has no reading to watch: its plan waits from the start.
  // Held still (`?still`), it reads for ever and nothing else moves.
  const still = stillRequested()
  const reading = still ? Number.POSITIVE_INFINITY : lessMotion() ? 0 : readingMs
  const story = visitorStory(agentTranscripts(now), turns, nudgeMs, reading)
  const life = visitorAmbient(turns)
  const base = demoBackend(
    createDemoEngine(),
    false,
    ambient && !still ? life.introOf : undefined,
    undefined,
    visitorSeed(now, reading > 0),
  )
  const storied = story.wrap(withConversations(base, story.transcripts, turns))
  const backend = ambient && !still ? life.wrap(storied) : storied
  return {
    seed: backend.seed,
    newTerminal: backend.newTerminal,
    commit: backend.commit,
    TerminalSurface: surfaceOf(backend),
    telemetry: backend.telemetry,
    ...(backend.companions && { companions: backend.companions }),
    ...(backend.start && { start: backend.start }),
    visitor: true,
  }
}

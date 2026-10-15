import type { Backend } from "../../port"
import { createDemoEngine } from "../engine"
import { demoBackend, withConversations, withStorefrontArtifacts } from "../index"
import { demoSeed } from "../samples"
import { agentTranscripts } from "../transcripts"
import { demoTurns } from "../turns"

// The demo for a website's visitors: the agents demo's storefront and its other projects as
// they stand, and without what a browser page can't offer: the debug panel, the chat view,
// connecting agents, voice, murmur, notices, updates and a version. The terminals' screens
// still read the agents' conversations. What it returns is listed field by field, so
// nothing added to the agents demo reaches a public page unasked.
export const visitorDemo = (): Backend => {
  const now = Date.now()
  const base = withStorefrontArtifacts({
    ...demoBackend(createDemoEngine()),
    seed: demoSeed(now, true),
  })
  const backend = withConversations(base, agentTranscripts(now), demoTurns())
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

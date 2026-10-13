import type { ConversationKey, Conversations } from "../../../model/conversation"
import { createStore, type MutableStore } from "../../../model/store"
import type { Workspace } from "../../../model/types"
import type { Backend } from "../../port"
import { createDemoEngine } from "../engine"
import { demoBackend, withConversations, withStorefrontArtifacts } from "../index"
import { demoSeed, demoTerminalId } from "../samples"
import { agentTranscripts } from "../transcripts"
import { demoTurns } from "../turns"
import { visitorBeats } from "./beats"
import { playScenario } from "./scenario"

// How long the person must be still before the scenario goes on.
export const stillMs = 4000

// The events that show the person is using the page.
const interactions = ["pointerdown", "keydown", "wheel"] as const

// Whether an answer is to the permission request in Checkout review, storefront's fourth
// terminal: the one the hints ask the person to answer.
export const answersCheckoutReview = (key: ConversationKey, request: string): boolean =>
  key.terminalId ===
    demoTerminalId({ projectId: "storefront", workspaceSessionId: "initial" }, 4) &&
  request === "04:permission"

// The conversations, ticking `answered` when the person answers that request.
export const tickingAnswers =
  (answered: MutableStore<boolean>) =>
  (conversations: Conversations): Conversations => ({
    ...conversations,
    answer: async (key, request, answer) => {
      await conversations.answer(key, request, answer)
      if (answersCheckoutReview(key, request)) answered.update(() => true)
    },
  })

// The demo for a website's visitors: the agents demo's storefront and its other projects,
// with their agents played by a scenario that goes on beside the person (see
// `playScenario`), and without what a browser page can't offer: the debug panel, the chat
// view, connecting agents, voice, murmur, notices, updates and a version. The terminals' screens still
// read the agents' conversations, which is how a request is answered there.
export const visitorDemo = (): Backend => {
  const turns = demoTurns()
  const answered = createStore(false)
  const now = Date.now()
  const base = withStorefrontArtifacts({
    ...demoBackend(createDemoEngine()),
    seed: demoSeed(now, true),
  })
  const {
    conversations: _conversations,
    voice: _voice,
    murmur: _murmur,
    typeInto: _typeInto,
    transcripts: _transcripts,
    agents: _agents,
    version: _version,
    ...backend
  } = withConversations(base, agentTranscripts(now), turns, tickingAnswers(answered))
  let latest: Workspace | undefined
  let touched = -Infinity
  const touch = (): void => void (touched = Date.now())
  return {
    ...backend,
    visitor: { answered },
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
    },
    start: (sink) => {
      const stop = backend.start?.(sink)
      for (const type of interactions) document.addEventListener(type, touch, true)
      const stopScenario = playScenario(visitorBeats, {
        verbs: turns,
        workspace: () => latest,
        working: turns.working,
        still: () => Date.now() - touched >= stillMs,
      })
      return () => {
        stopScenario()
        for (const type of interactions) document.removeEventListener(type, touch, true)
        stop?.()
      }
    },
  }
}

import { demoTerminalId } from "../samples"
import type { Beat } from "./scenario"

// A sample terminal by its project and number in the project's first session.
const at = (projectId: string, slot: number) => {
  const target = { projectId, workspaceSessionId: "initial" }
  return { ...target, terminalId: demoTerminalId(target, slot) }
}

const seconds = (count: number): number => count * 1000

// The pitch in about a minute and a half: while the person looks at storefront, agents in
// the other projects finish, ask and fail, and the switcher, the bell and the tabs mark
// each; then it goes quieter, a beat every half minute or so. Storefront's own
// permission request waits from the start for the person to answer.
export const visitorBeats: readonly Beat[] = [
  // Design system's agent finishes: the switcher marks it done and the bell rings.
  {
    after: seconds(6),
    on: [at("design-system", 1)],
    play: (verbs, key, terminal) => verbs.finish(key, terminal, "completed", { after: 1200 }),
  },
  // Tests finish in storefront itself, so its tab marks them unread.
  {
    after: seconds(9),
    on: [at("storefront", 3)],
    play: (verbs, key, terminal) => verbs.finish(key, terminal, "completed", { after: 1200 }),
  },
  // Mobile app's agent stops to ask permission.
  {
    after: seconds(11),
    on: [at("mobile-app", 1)],
    play: (verbs, key, terminal) => verbs.ask(key, terminal, "permission", 1),
  },
  // Infra's run fails.
  {
    after: seconds(13),
    on: [at("infra", 1)],
    play: (verbs, key, terminal) => verbs.finish(key, terminal, "failed", { after: 1200 }),
  },
  // Docs site's question is answered elsewhere, and its agent works on, then finishes.
  {
    after: seconds(16),
    on: [at("docs-site", 1)],
    play: (verbs, key, terminal) => verbs.finish(key, terminal, "completed", { after: 4000 }),
  },
  // The quieter part: one every half minute or so.
  {
    after: seconds(30),
    on: [at("api-service", 3), at("storefront", 6)],
    play: (verbs, key, terminal) => verbs.finish(key, terminal, "completed", { after: 2500 }),
  },
  {
    after: seconds(40),
    on: [at("api-service", 1)],
    play: (verbs, key, terminal) => verbs.ask(key, terminal, "question", 1),
  },
]

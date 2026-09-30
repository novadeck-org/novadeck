import type { ReactNode } from "react"

import type { AgentPlan, Artifact } from "../../../model/companion"
import { studioArtifacts } from "./artifacts"
import authV1 from "./plans/auth-v1.md?raw"
import authV2 from "./plans/auth-v2.md?raw"
import studioV1 from "./plans/studio-v1.md?raw"
import studioV2 from "./plans/studio-v2.md?raw"

// A sample agent in a showcase terminal: the plan it wrote and its later revisions, what
// it shows, how its terminal opens, and what it says back.
export type SampleAgent = {
  readonly plan: Omit<AgentPlan, "text">
  // Each revision's Markdown, oldest first. Feedback moves it to the next one.
  readonly revisions: readonly string[]
  readonly artifacts: { readonly shown: readonly Artifact[]; readonly next: readonly Artifact[] }
  readonly transcript: ReactNode
  readonly reply: (input: string) => string
}

// Codex with a structured plan and NovaDeck's skill: it re-reads the plan on its own.
export const studioAgent: SampleAgent = {
  plan: { path: "plans/studio.md", agent: "Codex", skill: true },
  revisions: [studioV1, studioV2],
  artifacts: studioArtifacts,
  transcript: (
    <>
      <p className="text-muted">~/projects/studio · codex</p>
      <p className="output-gap">
        <strong>❯ Plan a small portfolio for Studio before we start building.</strong>
      </p>
      <div className="output-gap text-muted">
        <p>✓ Reviewed the project structure</p>
        <p>✓ Wrote plans/studio.md</p>
      </div>
      <p className="output-gap">The plan is ready.</p>
      <p className="output-gap">
        <strong>Implement this plan?</strong>{" "}
        <span className="text-muted">y to approve · anything else to keep planning</span>
      </p>
      <p className="output-gap text-muted">
        Demo: type show to have Codex show you something, or open to ask it to open it.
      </p>
    </>
  ),
  reply: (input) =>
    /^show\b/i.test(input)
      ? "Here's something to look at. It's beside this terminal."
      : /^open\b/i.test(input)
        ? "Opening it for you."
        : /^(y|yes)$/i.test(input)
          ? "Approved. Re-reading plans/studio.md for your notes, then starting."
          : "Keeping the plan open. Re-reading plans/studio.md for your notes and revising.",
}

// Claude Code with a prose plan and no skill: notes wait until it's asked to re-read.
export const authAgent: SampleAgent = {
  plan: { path: "~/.claude/plans/refactor-auth.md", agent: "Claude Code", skill: false },
  revisions: [authV1, authV2],
  artifacts: { shown: [], next: [] },
  transcript: (
    <>
      <p className="text-muted">~/projects/studio · claude</p>
      <p className="output-gap">
        <strong>❯ Why does the mobile app log people out early? Plan a fix first.</strong>
      </p>
      <div className="output-gap text-muted">
        <p>● Read server/auth.ts</p>
        <p>● Read 3 route files</p>
        <p>● Wrote ~/.claude/plans/refactor-auth.md</p>
      </div>
      <p className="output-gap">
        Expiry is checked three different ways. I’ve written up a plan to consolidate it.
      </p>
      <p className="output-gap">
        <strong>Would you like to proceed?</strong>{" "}
        <span className="text-muted">y to approve · or tell Claude what to change</span>
      </p>
    </>
  ),
  reply: (input) =>
    /re-?read/i.test(input)
      ? "Re-reading ~/.claude/plans/refactor-auth.md. Applying the note you left and removing it."
      : /^(y|yes)$/i.test(input)
        ? "Approved. Starting on the plan."
        : "Revising the plan with what you said.",
}

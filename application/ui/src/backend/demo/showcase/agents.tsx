import type { ReactNode } from "react"

import { studioArtifacts, type SampleArtifacts } from "./artifacts"
import authV1 from "./plans/auth-v1.md?raw"
import studioV1 from "./plans/studio-v1.md?raw"
import type { PlanEdit } from "./revise"

// A sample agent in a showcase terminal: the plan it wrote and how it revises it, what
// it shows, how its terminal opens, and what it says back.
export type SampleAgent = {
  // Its plan's item, by an id that stays the same; where the file is, the agent by the
  // name the person knows it by, and whether NovaDeck's skill is installed for it.
  readonly plan: {
    readonly id: string
    readonly path: string
    readonly agent: string
    readonly skill: boolean
  }
  // The plan as the agent first wrote it.
  readonly text: string
  // Each later revision, as edits to the file as it then stands. Feedback moves it on.
  readonly revisions: readonly (readonly PlanEdit[])[]
  readonly artifacts: SampleArtifacts
  readonly transcript: ReactNode
  readonly reply: (input: string) => string
}

// Codex with a structured plan and NovaDeck's skill: it re-reads the plan on its own.
export const studioAgent: SampleAgent = {
  plan: { id: "studio-plan", path: "plans/studio.md", agent: "Codex", skill: true },
  text: studioV1,
  revisions: [
    [
      {
        line: "Let the work lead. Pair generous space with expressive serif headlines, quiet navigation, and a warm ivory background.",
        with: "Let the work lead. Pair generous space with a confident grotesk for headlines, quiet navigation, and a warm ivory background.",
      },
      {
        line: "2. [ ] **Build the home page** in `pages/Home.tsx`: introduction, three selected projects, a short contact section.",
        with: "2. [ ] **Build the home page** in `pages/Home.tsx`: introduction, one featured project at full width, then a short contact section.",
      },
      {
        after:
          "4. [ ] **Refine the smaller layouts.** Stack the project grid on mobile and keep reading widths comfortable.",
        insert: "5. [ ] **Add a Journal page** in `pages/Journal.tsx` for short studio notes.",
      },
    ],
  ],
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
  plan: {
    id: "auth-plan",
    path: "~/.claude/plans/refactor-auth.md",
    agent: "Claude Code",
    skill: false,
  },
  text: authV1,
  revisions: [
    [
      {
        line: "One open question: admin routes currently accept tokens for up to 24 hours. Should they follow the same rule, or keep a shorter window?",
        with: "Admin routes will keep a shorter window: tokens older than one hour are rejected there even when the refresh would succeed elsewhere.",
      },
    ],
  ],
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

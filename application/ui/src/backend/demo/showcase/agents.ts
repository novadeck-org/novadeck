import type { Block } from "../screen/screen"
import { span, wrap, type Line, type Style } from "../screen/vt"
import { studioArtifacts, type SampleArtifacts } from "./artifacts"
import authV1 from "./plans/auth-v1.md?raw"
import studioV1 from "./plans/studio-v1.md?raw"
import type { PlanEdit } from "./revise"

// A sample agent in a showcase terminal: the plan it wrote and how it revises it, what
// it shows, how its terminal opens, and what it says back.
export type SampleAgent = {
  // Its plan's item, by an id that stays the same; where the file is, the agent by the
  // name the person knows it by, and whether Novadeck's skill is installed for it.
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
  // How its terminal opens, as terminal output.
  readonly transcript: readonly Block[]
}

const gap: Line = []
// A paragraph after a blank row, or the first one without.
const said =
  (text: string, first = false, ...style: Style[]): Block =>
  (width) => [...(first ? [] : [gap]), ...wrap([span(text, ...style)], width)]
// The steps the agent took, muted, after a blank row.
const steps =
  (...lines: readonly string[]): Block =>
  (width) => [gap, ...lines.flatMap((line) => wrap([span(line, "muted")], width))]

// Codex with a structured plan and Novadeck's skill: it re-reads the plan on its own.
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
  transcript: [
    said("~/projects/studio · codex", true, "muted"),
    said("❯ Plan a small portfolio for Studio before we start building.", false, "bold"),
    steps("✓ Reviewed the project structure", "✓ Wrote plans/studio.md"),
    said("The plan is ready."),
    said(
      "Demo: once the plan is approved, type show to have Codex show you something, or open to ask it to open it.",
      false,
      "muted",
    ),
  ],
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
  transcript: [
    said("~/projects/studio · claude", true, "muted"),
    said("❯ Why does the mobile app log people out early? Plan a fix first.", false, "bold"),
    steps(
      "● Read server/auth.ts",
      "● Read 3 route files",
      "● Wrote ~/.claude/plans/refactor-auth.md",
    ),
    said("Expiry is checked three different ways. I’ve written up a plan to consolidate it."),
  ],
}

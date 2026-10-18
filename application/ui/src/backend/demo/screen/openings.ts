import type { DemoAgent } from "../samples"
import { callBlock, diffBlock, dividerBlock, requestBlock, resultBlock, textBlock } from "./agent"
import type { Block } from "./screen"
import { box, span, wrap, type Line } from "./vt"

// How a demo agent's terminal opens: the agent's banner and the turn it was in.

// How far Claude Code's reading has come, where it opens still reading: 0 before it opens
// the file, 1 with the file open, 2 once read.
export type ReadingStep = 0 | 1 | 2

// When Claude Code, still reading as its terminal opens, has opened the file and has read
// it, in milliseconds after the terminal opened; the plan follows (see visitor/story.ts).
// The page around a framed app shows it a moment after it booted, so the reading starts
// with the app's first seconds gone, which a visitor doesn't see.
const readOpensMs = 2200
const readEndsMs = 3500

// How far the reading has come `since` the terminal opened, and when it next moves on. Not
// reading, or where motion is reduced, it has read already; held still, it has not begun.
export const readingAt = (
  since: number | undefined,
  { still, less, now }: { still: boolean; less: boolean; now: number },
): { readonly step: ReadingStep; readonly nextIn?: number } => {
  if (since === undefined || (less && !still)) return { step: 2 }
  if (still) return { step: 0 }
  const elapsed = now - since
  if (elapsed >= readEndsMs) return { step: 2 }
  if (elapsed >= readOpensMs) return { step: 1, nextIn: readEndsMs - elapsed }
  return { step: 0, nextIn: readOpensMs - elapsed }
}

const gap: Line = []

// The agent's name and where it runs: Claude Code's on a line, Codex's in a box.
const banner =
  (agent: DemoAgent, directory: string): Block =>
  (width) => {
    if (agent === "claude")
      return [...wrap([span("✳ Claude Code", "bold"), span(`  ${directory}`, "muted")], width), gap]
    const name: Line = [span(">_ Codex", "bold")]
    const where: Line = [span(directory, "muted")]
    const widest = Math.max(">_ Codex".length, directory.length)
    return [
      ...box(Math.min(width, widest + 4), (inner) => [...wrap(name, inner), ...wrap(where, inner)]),
      gap,
    ]
  }

// Claude Code asked to plan: what it read before proposing, as far as `step`. The plan
// itself waits as a request, which the tail shows. The blocks of a later step start with
// an earlier step's, so a screen moves on by appending what it adds.
const claudePlan = (step: ReadingStep): Block[] => [
  requestBlock("claude", "Plan a compact order summary for the checkout page."),
  (width) => wrap([span("I’ll read the checkout layout before proposing changes.")], width),
  ...(step > 0 ? [callBlock("claude", "Read", "src/checkout/Checkout.tsx")] : []),
  ...(step > 1 ? [resultBlock(["Read 128 lines"])] : []),
]

const claudeDone: Block[] = [
  requestBlock("claude", "Add a compact order summary to the checkout page."),
  (width) =>
    wrap([span("I’ll check the checkout layout and reuse its existing components.")], width),
  callBlock("claude", "Read", "src/checkout/Checkout.tsx"),
  resultBlock(["Read 128 lines"]),
  callBlock("claude", "Update", "src/checkout/OrderSummary.tsx"),
  resultBlock(["Added 12 lines, removed 3 lines"]),
  diffBlock([
    '− <div className="order-total">',
    '+ <section aria-label="Order summary">',
    "+   <OrderItems items={cart.items} />",
    "+   <OrderTotal amount={cart.total} />",
    "+ </section>",
  ]),
  callBlock("claude", "Bash", "pnpm test -- checkout"),
  resultBlock(["6 tests passed · 842ms"]),
  textBlock(
    "Added the order summary with item counts and totals. It stacks below the form on smaller screens. All checkout tests pass.",
  ),
  textBlock("✻ Worked for 38s", "muted"),
]

// Codex asked to review: what it looked at so far. Done reviewing, it ran the tests and
// reported; still at it, it stops after the diff.
const codexReview = (done: boolean): Block[] => [
  requestBlock("codex", "Review the checkout changes for regressions."),
  (width) =>
    wrap(
      [span("I’ll inspect the diff and check the empty-cart and quantity-update cases.")],
      width,
    ),
  callBlock("codex", "Explored"),
  resultBlock(["Read Checkout.tsx, OrderSummary.tsx", "Read checkout.spec.ts"]),
  callBlock("codex", "Ran", "git diff --stat"),
  resultBlock(["2 files changed, 24 insertions(+), 8 deletions(-)"]),
  ...(done
    ? [
        callBlock("codex", "Ran", "pnpm test -- checkout"),
        resultBlock(["Test Files 1 passed · Tests 6 passed"]),
        dividerBlock("Worked for 24s"),
        textBlock("No regressions found in the reviewed changes."),
        (width: number) =>
          wrap(
            [
              span(
                "The total updates with quantity changes, and an empty cart disables checkout. Existing tests cover both paths.",
                "muted",
              ),
            ],
            width,
          ),
      ]
    : []),
]

// How the agent's terminal opens: planning (Claude Code, read as far as `step`), done with
// its change (Claude Code), or reviewing, done or still at it (Codex).
export const openingBlocks = (
  agent: DemoAgent,
  directory: string,
  {
    planned = false,
    reviewing = false,
    step = 2,
  }: {
    planned?: boolean
    reviewing?: boolean
    step?: ReadingStep
  } = {},
): Block[] => [
  banner(agent, directory),
  ...(agent === "claude" ? (planned ? claudePlan(step) : claudeDone) : codexReview(!reviewing)),
]

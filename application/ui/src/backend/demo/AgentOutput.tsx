import { useEffect, useState } from "react"

import { lessMotion, stillRequested } from "./motion"
import type { DemoAgent } from "./samples"

// When Claude Code, still reading as its terminal opens, has opened the file and has read
// it, in milliseconds after the terminal opened; the plan follows (see visitor/story.ts).
// The page around a framed app shows it a moment after it booted, so the reading starts
// with the app's first seconds gone, which a visitor doesn't see.
const readOpensMs = 2200
const readEndsMs = 3500

// How far Claude Code's reading has come: 0 before it opens the file, 1 with the file open,
// 2 once read. Reading from `since`, so that a screen remounted midway resumes. Not
// reading, or where motion is reduced, it has read already.
const readingStep = (since: number | undefined): 0 | 1 | 2 => {
  if (since === undefined) return 2
  // Held still, it has not begun to read; with less motion, it has read already.
  if (stillRequested()) return 0
  if (lessMotion()) return 2
  const elapsed = Date.now() - since
  return elapsed >= readEndsMs ? 2 : elapsed >= readOpensMs ? 1 : 0
}

const useReading = (since: number | undefined): 0 | 1 | 2 => {
  const [step, setStep] = useState(() => readingStep(since))
  useEffect(() => {
    if (step === 2 || since === undefined) return
    const next = step === 0 ? readOpensMs : readEndsMs
    const timer = setTimeout(
      () => setStep(readingStep(since)),
      Math.max(0, since + next - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [step, since])
  return step
}

// Claude Code asked to plan: what it read before proposing. The plan itself waits as a
// request, shown by the terminal's screen while there is one. Where it opens still reading
// (`since` says when), it reads the file in front of the visitor first.
const ClaudePlan = ({ since }: { since: number | undefined }): React.JSX.Element => {
  const step = useReading(since)
  return (
    <>
      <p className="agent-request mb-4 px-3 py-2">
        ❯ Plan a compact order summary for the checkout page.
      </p>
      <p>I’ll read the checkout layout before proposing changes.</p>
      {step > 0 && (
        <div className="agent-tool mt-4">
          <p>
            ● <strong>Read</strong> src/checkout/Checkout.tsx
          </p>
          {step > 1 && <p className="agent-tool-result pl-3 muted">└ Read 128 lines</p>}
        </div>
      )}
    </>
  )
}

// Codex asked to review: what it looked at so far. Done reviewing, it ran the tests and
// reported; still at it, it stops after the diff.
const CodexReview = ({ done }: { done: boolean }): React.JSX.Element => (
  <>
    <p className="agent-request mb-4 px-3 py-2">› Review the checkout changes for regressions.</p>
    <p>I’ll inspect the diff and check the empty-cart and quantity-update cases.</p>
    <div className="agent-tool mt-4">
      <p>
        • <strong>Explored</strong>
      </p>
      <p className="agent-tool-result pl-3 muted">└ Read Checkout.tsx, OrderSummary.tsx</p>
      <p className="agent-tool-result pl-3 muted">&nbsp; Read checkout.spec.ts</p>
    </div>
    <div className="agent-tool mt-4">
      <p>
        • <strong>Ran</strong> git diff --stat
      </p>
      <p className="agent-tool-result pl-3 muted">
        └ 2 files changed, 24 insertions(+), 8 deletions(-)
      </p>
    </div>
    {done && (
      <>
        <div className="agent-tool mt-4">
          <p>
            • <strong>Ran</strong> pnpm test -- checkout
          </p>
          <p className="agent-tool-result pl-3 muted">└ Test Files 1 passed · Tests 6 passed</p>
        </div>
        <p className="agent-divider mt-4 pt-3 text-[0.85em] muted">Worked for 24s</p>
        <div className="agent-answer mt-5">
          <p>No regressions found in the reviewed changes.</p>
          <p className="muted">
            The total updates with quantity changes, and an empty cart disables checkout. Existing
            tests cover both paths.
          </p>
        </div>
      </>
    )}
  </>
)

// Whether the agent opened planning, or reviewing still, is decided by the caller, once per
// terminal, so that remounting this leaves the opening as it was.
export const AgentOutput = ({
  agent,
  directory,
  planned = false,
  reviewing = false,
  reading,
}: {
  agent: DemoAgent
  directory: string
  planned?: boolean
  reviewing?: boolean
  // Where Claude Code opens still reading, when its terminal opened.
  reading?: { readonly since: number } | undefined
}): React.JSX.Element => {
  return (
    <div
      className={`agent-transcript max-w-180 [overflow-wrap:anywhere] leading-[1.65] agent-${agent}`}
    >
      <div
        className={`agent-banner mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1 [&>span]:text-[0.85em] ${agent === "codex" ? "w-fit max-w-full flex-col px-3 py-2" : ""}`}
      >
        <strong>{agent === "claude" ? "✳ Claude Code" : ">_ Codex"}</strong>
        <span className="muted">{directory}</span>
      </div>
      {agent === "claude" && planned ? (
        <ClaudePlan since={reading?.since} />
      ) : agent === "claude" ? (
        <>
          <p className="agent-request mb-4 px-3 py-2">
            ❯ Add a compact order summary to the checkout page.
          </p>
          <p>I’ll check the checkout layout and reuse its existing components.</p>
          <div className="agent-tool mt-4">
            <p>
              ● <strong>Read</strong> src/checkout/Checkout.tsx
            </p>
            <p className="agent-tool-result pl-3 muted">└ Read 128 lines</p>
          </div>
          <div className="agent-tool mt-4">
            <p>
              ● <strong>Update</strong> src/checkout/OrderSummary.tsx
            </p>
            <p className="agent-tool-result pl-3 muted">└ Added 12 lines, removed 3 lines</p>
            <pre className="agent-diff mt-2 ml-3 overflow-x-auto py-1 pl-3 [font-weight:inherit] [line-height:inherit] text-[0.9em] whitespace-pre-wrap [overflow-wrap:anywhere]">
              <span className="muted">{'− <div className="order-total">\n'}</span>
              {
                '+ <section aria-label="Order summary">\n+   <OrderItems items={cart.items} />\n+   <OrderTotal amount={cart.total} />\n+ </section>'
              }
            </pre>
          </div>
          <div className="agent-tool mt-4">
            <p>
              ● <strong>Bash</strong> pnpm test -- checkout
            </p>
            <p className="agent-tool-result pl-3 muted">└ 6 tests passed · 842ms</p>
          </div>
          <p className="agent-answer mt-5">
            Added the order summary with item counts and totals. It stacks below the form on smaller
            screens. All checkout tests pass.
          </p>
          <p className="agent-completion mt-4 muted text-[0.85em]">✻ Worked for 38s</p>
        </>
      ) : (
        <CodexReview done={!reviewing} />
      )}
    </div>
  )
}

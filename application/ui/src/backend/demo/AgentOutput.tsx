export const AgentOutput = ({
  agent,
  directory,
}: {
  agent: "claude" | "codex"
  directory: string
}): React.JSX.Element => (
  <div
    className={`agent-transcript max-w-180 [overflow-wrap:anywhere] leading-[1.65] agent-${agent}`}
  >
    <div
      className={`agent-banner mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-1 [&>span]:text-[0.85em] ${agent === "codex" ? "w-fit max-w-full flex-col border border-line px-3 py-2" : ""}`}
    >
      <strong>{agent === "claude" ? "✳ Claude Code" : ">_ Codex"}</strong>
      <span className="text-muted">{directory}</span>
    </div>
    {agent === "claude" ? (
      <>
        <p className="agent-request mb-4 border-l-2 border-line bg-soft px-3 py-2">
          ❯ Add a compact order summary to the checkout page.
        </p>
        <p>I’ll check the checkout layout and reuse its existing components.</p>
        <div className="agent-tool mt-4">
          <p>
            ● <strong>Read</strong> src/checkout/Checkout.tsx
          </p>
          <p className="agent-tool-result pl-3 text-muted">└ Read 128 lines</p>
        </div>
        <div className="agent-tool mt-4">
          <p>
            ● <strong>Update</strong> src/checkout/OrderSummary.tsx
          </p>
          <p className="agent-tool-result pl-3 text-muted">└ Added 12 lines, removed 3 lines</p>
          <pre className="agent-diff mt-2 ml-3 overflow-x-auto border-l border-line py-1 pl-3 [font-family:inherit] [font-weight:inherit] [line-height:inherit] text-[0.9em] whitespace-pre-wrap [overflow-wrap:anywhere]">
            <span className="text-muted">{'− <div className="order-total">\n'}</span>
            {
              '+ <section aria-label="Order summary">\n+   <OrderItems items={cart.items} />\n+   <OrderTotal amount={cart.total} />\n+ </section>'
            }
          </pre>
        </div>
        <div className="agent-tool mt-4">
          <p>
            ● <strong>Bash</strong> pnpm test -- checkout
          </p>
          <p className="agent-tool-result pl-3 text-muted">└ 6 tests passed · 842ms</p>
        </div>
        <p className="agent-answer mt-5">
          Added the order summary with item counts and totals. It stacks below the form on smaller
          screens. All checkout tests pass.
        </p>
        <p className="agent-completion mt-4 text-muted text-[0.85em]">✻ Worked for 38s</p>
      </>
    ) : (
      <>
        <p className="agent-request mb-4 border-l-2 border-line bg-soft px-3 py-2">
          › Review the checkout changes for regressions.
        </p>
        <p>I’ll inspect the diff and check the empty-cart and quantity-update cases.</p>
        <div className="agent-tool mt-4">
          <p>
            • <strong>Explored</strong>
          </p>
          <p className="agent-tool-result pl-3 text-muted">└ Read Checkout.tsx, OrderSummary.tsx</p>
          <p className="agent-tool-result pl-3 text-muted">&nbsp; Read checkout.spec.ts</p>
        </div>
        <div className="agent-tool mt-4">
          <p>
            • <strong>Ran</strong> git diff --stat
          </p>
          <p className="agent-tool-result pl-3 text-muted">
            └ 2 files changed, 24 insertions(+), 8 deletions(-)
          </p>
        </div>
        <div className="agent-tool mt-4">
          <p>
            • <strong>Ran</strong> pnpm test -- checkout
          </p>
          <p className="agent-tool-result pl-3 text-muted">
            └ Test Files 1 passed · Tests 6 passed
          </p>
        </div>
        <p className="agent-divider mt-4 border-t border-line pt-3 text-[0.85em] text-muted">
          Worked for 24s
        </p>
        <div className="agent-answer mt-5">
          <p>No regressions found in the reviewed changes.</p>
          <p className="text-muted">
            The total updates with quantity changes, and an empty cart disables checkout. Existing
            tests cover both paths.
          </p>
        </div>
      </>
    )}
  </div>
)

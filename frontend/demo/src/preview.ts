import type { PreviewHunk, Work, WorkPreview, WorkPreviewWork } from "@novadeck/core/works"

import { demoTerminalId } from "./samples"

// The demo's file previews: src/checkout/Checkout.tsx of the storefront as it would be once its
// agents' work merges onto main. Moth and Crow each change it (they both rewrite the line that
// submits the order, which is a clash); each write one of them makes grows its live change by a
// line; the debug panel has a third agent, Owl, change it too, in a clash or in lines main has
// since rewritten (a change that doesn't apply). The agents are the storefront's terminals by
// slot, as the demo's Source names them.

const projectId = "storefront"
const session = { projectId, workspaceSessionId: "initial" }
const minute = 60_000

export const previewPath = "src/checkout/Checkout.tsx"

// Main's copy.
export const previewMain =
  [
    `import { useState } from "react"`,
    `import { useCart } from "../cart/useCart"`,
    `import { Price } from "../components/Price"`,
    `import { AddressForm } from "./AddressForm"`,
    `import { PaymentStep, type PaymentDetails } from "./PaymentStep"`,
    `import { placeOrder } from "../api/orders"`,
    ``,
    `type Step = "address" | "payment" | "done"`,
    ``,
    `export const Checkout = () => {`,
    `  const { items, total } = useCart()`,
    `  const [step, setStep] = useState<Step>("address")`,
    `  const [error, setError] = useState<string | null>(null)`,
    ``,
    `  const submit = async (payment: PaymentDetails) => {`,
    `    setError(null)`,
    `    try {`,
    `      await placeOrder({ items, payment })`,
    `      setStep("done")`,
    `    } catch (err) {`,
    `      setError(String(err))`,
    `    }`,
    `  }`,
    ``,
    `  if (step === "done") return <p>Thanks! Your order is on its way.</p>`,
    ``,
    `  return (`,
    `    <section className="checkout">`,
    `      <aside className="checkout-summary">`,
    `        {items.map((item) => (`,
    `          <div key={item.id}>{item.name} × {item.qty}</div>`,
    `        ))}`,
    `        <Price value={total} />`,
    `      </aside>`,
    `      {step === "address" ? (`,
    `        <AddressForm onDone={() => setStep("payment")} />`,
    `      ) : (`,
    `        <PaymentStep onSubmit={submit} error={error} />`,
    `      )}`,
    `    </section>`,
    `  )`,
    `}`,
  ].join("\n") + "\n"

const hunk = (at: number, removed: number, lines: string[], applies = true): PreviewHunk => ({
  at,
  removed,
  lines,
  applies,
})

// Who changes the file, by the slot of its terminal: its hunks, the lines its latest write adds
// one at a time (the last hunk grows by them, then starts again), and how long ago it last wrote.
type Script = {
  readonly slot: number
  readonly hunks: readonly PreviewHunk[]
  readonly pool: readonly string[]
  readonly agoMs: number
}

const moth: Script = {
  slot: 1,
  agoMs: 10 * minute,
  hunks: [
    hunk(7, 0, [`import { OrderSummary } from "./OrderSummary"`]),
    hunk(11, 1, [`  const { items, total, clear } = useCart()`]),
    hunk(18, 1, [`      const order = await placeOrder({ items, payment })`, `      clear()`]),
    hunk(29, 6, [`      <OrderSummary items={items} total={total} />`]),
  ],
  pool: [
    `      <ShippingEstimate items={items} />`,
    `      <PromoCode onApply={apply} />`,
    `      <Totals total={total} />`,
  ],
}

const crow: Script = {
  slot: 4,
  agoMs: minute,
  hunks: [
    hunk(5, 1, [
      `import { PaymentForm, type PaymentDetails } from "./PaymentForm"`,
      `import { createPayment } from "../api/payments"`,
    ]),
    hunk(18, 1, [
      `      const intent = await createPayment(payment, total)`,
      `      await placeOrder({ items, paymentId: intent.id })`,
    ]),
    hunk(38, 1, [`        <PaymentForm onSubmit={submit} error={error} />`]),
  ],
  pool: [
    `        {error && <p role="alert">{error}</p>}`,
    `        <Terms />`,
    `        <SecurePayment />`,
  ],
}

// The third agent's change, when the debug panel has it: over lines Moth and Crow also change,
// or over a line main has rewritten since it branched.
const owlClash = hunk(18, 1, [`      const result = await submitOrder({ items, payment, total })`])
const owlStale = hunk(
  25,
  1,
  [`  if (step === "done") return <p data-testid="done">Thank you!</p>`],
  false,
)

export const owlSlot = 3

export type OwlChange = "clash" | "stale"

export type DemoPreview = {
  // The file as it would be once the works merge: the storefront's, for the works that change it.
  readonly read: (works: readonly Work[], project: string, path: string) => WorkPreview
  // The agent in the terminal wrote the file at `at`: its live change grows.
  readonly wrote: (terminalId: string, at: number) => void
  // The third agent changes the file as given, or no longer.
  readonly owl: (change: OwlChange | undefined, at: number) => void
  // The terminal the third agent works in.
  readonly owlTerminal: string
}

export const createDemoPreview = (now: number): DemoPreview => {
  const scripts = [moth, crow]
  const terminalOf = (script: Script): string => demoTerminalId(session, script.slot)
  const grown = new Map<string, number>()
  const changedAt = new Map(scripts.map((script) => [terminalOf(script), now - script.agoMs]))
  let owl: { change: OwlChange; at: number } | undefined
  const owlTerminal = demoTerminalId(session, owlSlot)
  const hunksOf = (script: Script): readonly PreviewHunk[] => {
    const extra = script.pool.slice(
      0,
      (grown.get(terminalOf(script)) ?? 0) % (script.pool.length + 1),
    )
    const last = script.hunks.at(-1)!
    return [...script.hunks.slice(0, -1), { ...last, lines: [...last.lines, ...extra] }]
  }
  return {
    owlTerminal,
    read: (works, project, path) => {
      if (project !== projectId || path !== previewPath) return { main: null, works: [] }
      const found: WorkPreviewWork[] = []
      const add = (terminalId: string, hunks: readonly PreviewHunk[], at: number): void => {
        const work = works.find(
          (each) =>
            each.projectId === projectId &&
            each.terminalId === terminalId &&
            each.files.some((file) => file.path === path),
        )
        if (work)
          found.push({
            root: work.root,
            terminalId,
            branch: work.branch,
            status: "modified",
            changedAt: at,
            hunks,
          })
      }
      for (const script of scripts)
        add(terminalOf(script), hunksOf(script), changedAt.get(terminalOf(script))!)
      if (owl) add(owlTerminal, [owl.change === "clash" ? owlClash : owlStale], owl.at)
      return { main: previewMain, works: found }
    },
    wrote: (terminalId, at) => {
      if (!changedAt.has(terminalId)) return
      grown.set(terminalId, (grown.get(terminalId) ?? 0) + 1)
      changedAt.set(terminalId, at)
    },
    owl: (change, at) => {
      owl = change === undefined ? undefined : { change, at }
    },
  }
}

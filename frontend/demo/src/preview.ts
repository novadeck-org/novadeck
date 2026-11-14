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

// Two more files of the storefront the previews cover: one Moth adds (and Crow too, when the debug
// panel has it add the same path), and one Crow renames to another path (when the debug panel has
// it) while Moth modifies it.
export const addedPath = "src/checkout/OrderSummary.tsx"
export const renamedPath = "src/checkout/PaymentStep.tsx"
export const renamedTo = "src/checkout/PaymentForm.tsx"

const orderMoth = [
  `import type { CartItem } from "../cart/useCart"`,
  `import { Price } from "../components/Price"`,
  ``,
  `type Props = { items: CartItem[]; total: number }`,
  ``,
  `export const OrderSummary = ({ items, total }: Props) => (`,
  `  <aside className="checkout-summary">`,
  `    {items.map((item) => (`,
  `      <div key={item.id}>{item.name} × {item.qty}</div>`,
  `    ))}`,
  `    <Price value={total} />`,
  `  </aside>`,
  `)`,
]
const orderCrow = [
  `import { Price } from "../components/Price"`,
  ``,
  `export const OrderSummary = ({ total }: { total: number }) => (`,
  `  <p className="checkout-total">Total: <Price value={total} /></p>`,
  `)`,
]

const stepMain =
  [
    `import type { PaymentDetails } from "../api/payments"`,
    `import { Button } from "../components/Button"`,
    ``,
    `type Props = { onSubmit: (payment: PaymentDetails) => void; error: string | null }`,
    ``,
    `export const PaymentStep = ({ onSubmit, error }: Props) => {`,
    `  const submit = () => onSubmit({ method: "card" })`,
    `  return (`,
    `    <div className="payment-step">`,
    `      {error && <p role="alert">{error}</p>}`,
    `      <Button onClick={submit}>Pay</Button>`,
    `    </div>`,
    `  )`,
    `}`,
  ].join("\n") + "\n"
// Moth edits the old file; Crow's own edit, in the file it renamed it to, is on another line.
const stepMoth = hunk(10, 1, [`      {error && <p role="alert" className="error">{error}</p>}`])
const stepCrow = hunk(11, 1, [`      <Button onClick={submit}>Pay now</Button>`])

export type PreviewScenario = "added" | "rename"

export type DemoPreview = {
  // The file as it would be once the works merge: the storefront's, for the works that change it.
  readonly read: (works: readonly Work[], project: string, path: string) => WorkPreview
  // The agent in the terminal wrote the file at `at`: its live change grows.
  readonly wrote: (terminalId: string, at: number) => void
  // The third agent changes the file as given, or no longer.
  readonly owl: (change: OwlChange | undefined, at: number) => void
  // Crow adds the file Moth adds too, or renames the file Moth modifies, or no longer, at `at`.
  readonly scenario: (which: PreviewScenario, on: boolean, at: number) => void
  // The terminals the third agent, Moth and Crow work in.
  readonly owlTerminal: string
  readonly mothTerminal: string
  readonly crowTerminal: string
}

export const createDemoPreview = (now: number): DemoPreview => {
  const scripts = [moth, crow]
  const terminalOf = (script: Script): string => demoTerminalId(session, script.slot)
  const grown = new Map<string, number>()
  const changedAt = new Map(scripts.map((script) => [terminalOf(script), now - script.agoMs]))
  let owl: { change: OwlChange; at: number } | undefined
  const scenarios = new Map<PreviewScenario, number>()
  const owlTerminal = demoTerminalId(session, owlSlot)
  const mothTerminal = terminalOf(moth)
  const crowTerminal = terminalOf(crow)
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
    mothTerminal,
    crowTerminal,
    read: (works, project, path) => {
      const empty: WorkPreview = { main: null, works: [], renames: [] }
      if (project !== projectId) return empty
      const found: WorkPreviewWork[] = []
      // A work of the terminal that lists `listed`, changing `path` as given.
      const add = (
        terminalId: string,
        listed: string,
        hunks: readonly PreviewHunk[],
        at: number,
        extra: Partial<WorkPreviewWork> = {},
      ): { root: string; branch: string | null } | undefined => {
        const work = works.find(
          (each) =>
            each.projectId === projectId &&
            each.terminalId === terminalId &&
            each.files.some((file) => file.path === listed),
        )
        if (work)
          found.push({
            root: work.root,
            terminalId,
            branch: work.branch,
            status: "modified",
            changedAt: at,
            hunks,
            ...extra,
          })
        return work
      }
      if (path === previewPath) {
        for (const script of scripts)
          add(terminalOf(script), path, hunksOf(script), changedAt.get(terminalOf(script))!)
        if (owl) add(owlTerminal, path, [owl.change === "clash" ? owlClash : owlStale], owl.at)
        return { main: previewMain, works: found, renames: [] }
      }
      if (path === addedPath) {
        add(mothTerminal, path, [hunk(1, 0, orderMoth)], now - 3 * minute, { status: "added" })
        const crowAt = scenarios.get("added")
        if (crowAt !== undefined)
          add(crowTerminal, path, [hunk(1, 0, orderCrow)], crowAt, { status: "added" })
        return { main: null, works: found, renames: [] }
      }
      if (path !== renamedPath && path !== renamedTo) return empty
      const renameAt = scenarios.get("rename")
      // The new path exists only while Crow renames; Moth's change to the old file stays.
      if (path === renamedTo && renameAt === undefined) return empty
      add(mothTerminal, renamedPath, [stepMoth], now - 3 * minute)
      if (path === renamedTo)
        add(crowTerminal, renamedTo, [stepCrow], renameAt!, { renamedFrom: renamedPath })
      const renamer = works.find(
        (each) => each.projectId === projectId && each.terminalId === crowTerminal,
      )
      const renames =
        path === renamedPath && renameAt !== undefined && renamer
          ? [
              {
                root: renamer.root,
                terminalId: crowTerminal,
                branch: renamer.branch,
                to: renamedTo,
              },
            ]
          : []
      return found.length > 0 || renames.length > 0
        ? { main: stepMain, works: found, renames }
        : empty
    },
    wrote: (terminalId, at) => {
      if (!changedAt.has(terminalId)) return
      grown.set(terminalId, (grown.get(terminalId) ?? 0) + 1)
      changedAt.set(terminalId, at)
    },
    owl: (change, at) => {
      owl = change === undefined ? undefined : { change, at }
    },
    scenario: (which, on, at) => {
      if (on) scenarios.set(which, at)
      else scenarios.delete(which)
    },
  }
}

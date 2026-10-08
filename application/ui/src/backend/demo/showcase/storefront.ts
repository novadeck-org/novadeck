import { fileLines, ready, svg, type SampleArtifact } from "./artifacts"

// What the agents demo's storefront terminals hold on their bars: a draft of the order
// summary and the code behind it beside the implementation, the spec and the empty cart
// beside the review, and the last run beside the tests. Nothing here changes; they're
// there to open, peek at and move.

const storefront = "~/projects/storefront"

const paper = "#fbfaf7"
const ink = "#1f2328"
const muted = "#6b7280"
const line = "#e5e2db"
const accent = "#2f6f5e"

const file = (
  id: string,
  path: string,
  lines: readonly string[],
  pointed?: { readonly from: number; readonly to: number },
): SampleArtifact => ({
  item: {
    id,
    kind: "file",
    name: path.split("/").at(-1)!,
    detail: pointed ? `${path} · lines ${pointed.from}–${pointed.to}` : path,
    path: `${storefront}/${path}`,
    url: null,
    lines: pointed ?? null,
    held: false,
  },
  content: ready(fileLines(path, lines, pointed ?? { from: 1, to: lines.length })),
})

const image = (id: string, name: string, body: string): SampleArtifact => ({
  item: {
    id,
    kind: "image",
    name,
    detail: "1600 × 900 PNG",
    path: `${storefront}/drafts/${name}`,
    url: null,
    lines: null,
    held: false,
  },
  content: ready({ kind: "image", src: svg(1600, 900, body) }),
})

const sans = 'font-family="Helvetica, Arial, sans-serif"'

const row = (y: number, label: string, price: string, strong = false): string =>
  `<text x="470" y="${y}" ${sans} font-size="15" fill="${strong ? ink : muted}" font-weight="${strong ? 700 : 400}">${label}</text>` +
  `<text x="730" y="${y}" ${sans} font-size="15" fill="${ink}" font-weight="${strong ? 700 : 400}" text-anchor="end">${price}</text>`

const orderSummary = image(
  "storefront-order-summary",
  "order-summary.png",
  `<rect width="800" height="450" fill="${paper}"/>` +
    `<text x="60" y="70" ${sans} font-size="22" font-weight="700" fill="${ink}">Checkout</text>` +
    [110, 160, 210, 260]
      .map(
        (y) =>
          `<rect x="60" y="${y}" width="360" height="36" rx="4" fill="#fff" stroke="${line}"/>`,
      )
      .join("") +
    `<rect x="60" y="320" width="360" height="44" rx="4" fill="${accent}"/>` +
    `<text x="240" y="348" ${sans} font-size="15" font-weight="700" fill="#fff" text-anchor="middle">Pay $148.00</text>` +
    `<rect x="450" y="90" width="300" height="290" rx="6" fill="#fff" stroke="${line}"/>` +
    `<text x="470" y="125" ${sans} font-size="17" font-weight="700" fill="${ink}">Order summary</text>` +
    `<rect x="470" y="145" width="44" height="44" rx="4" fill="#d9e6e1"/>` +
    `<text x="526" y="164" ${sans} font-size="14" fill="${ink}">Linen tote</text>` +
    `<text x="526" y="183" ${sans} font-size="12" fill="${muted}">Qty 2</text>` +
    `<rect x="470" y="205" width="44" height="44" rx="4" fill="#efe3cf"/>` +
    `<text x="526" y="224" ${sans} font-size="14" fill="${ink}">Canvas apron</text>` +
    `<text x="526" y="243" ${sans} font-size="12" fill="${muted}">Qty 1</text>` +
    `<line x1="470" y1="270" x2="730" y2="270" stroke="${line}"/>` +
    row(295, "Subtotal", "$136.00") +
    row(320, "Shipping", "$12.00") +
    row(355, "Total", "$148.00", true),
)

const emptyCart = image(
  "storefront-empty-cart",
  "empty-cart.png",
  `<rect width="800" height="450" fill="${paper}"/>` +
    `<circle cx="400" cy="170" r="54" fill="#eef3f1"/>` +
    `<path d="M372 152h8l10 40h28l8-28h-40" fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="394" cy="202" r="4" fill="${accent}"/><circle cx="416" cy="202" r="4" fill="${accent}"/>` +
    `<text x="400" y="270" ${sans} font-size="22" font-weight="700" fill="${ink}" text-anchor="middle">Your cart is empty</text>` +
    `<text x="400" y="300" ${sans} font-size="15" fill="${muted}" text-anchor="middle">Pick up where you left off, or browse what's new.</text>` +
    `<rect x="330" y="325" width="140" height="40" rx="4" fill="${accent}"/>` +
    `<text x="400" y="350" ${sans} font-size="14" font-weight="700" fill="#fff" text-anchor="middle">Keep shopping</text>`,
)

const summaryLines = [
  'import { OrderItems } from "./OrderItems"',
  'import { OrderTotal } from "./OrderTotal"',
  'import type { Cart } from "./cart"',
  "",
  "// Beside the checkout form on wide screens, under it on small ones.",
  "export const OrderSummary = ({ cart }: { cart: Cart }) => (",
  '  <section aria-label="Order summary" className="order-summary">',
  "    <h2>Order summary</h2>",
  "    {cart.items.length > 0 ? (",
  "      <>",
  "        <OrderItems items={cart.items} />",
  "        <OrderTotal amount={cart.total} shipping={cart.shipping} />",
  "      </>",
  "    ) : (",
  '      <p className="order-summary-empty">Your cart is empty</p>',
  "    )}",
  "  </section>",
  ")",
]

const copyLines = [
  "# Checkout copy",
  "",
  "Short, plain labels. The button says what happens and how much.",
  "",
  "| Place | Copy |",
  "| --- | --- |",
  "| Pay button | Pay $148.00 |",
  "| Summary heading | Order summary |",
  "| Empty cart | Your cart is empty |",
  "| Shipping, free | Free shipping |",
  "",
  "Never say *Submit*. Never apologise for a declined card; say what to try next.",
]

const specLines = [
  'import { expect, test } from "@playwright/test"',
  "",
  'test.describe("checkout order summary", () => {',
  '  test("lists each item with its quantity", async ({ page }) => {',
  '    await page.goto("/checkout?cart=two-items")',
  '    const summary = page.getByRole("region", { name: "Order summary" })',
  '    await expect(summary.getByText("Linen tote")).toBeVisible()',
  '    await expect(summary.getByText("Qty 2")).toBeVisible()',
  "  })",
  "",
  '  test("says the cart is empty instead of a zero total", async ({ page }) => {',
  '    await page.goto("/checkout?cart=empty")',
  '    await expect(page.getByText("Your cart is empty")).toBeVisible()',
  '    await expect(page.getByText("$0.00")).toBeHidden()',
  "  })",
  "})",
]

const reviewLines = [
  "# Review: checkout order summary",
  "",
  "Looks good overall. Two things before merging:",
  "",
  "1. `OrderTotal` recomputes shipping on every render; take it from the cart.",
  "2. The empty state needs a way back to the shop (see empty-cart.png).",
  "",
  "Checked: quantity changes, a cart emptied mid-checkout, narrow screens.",
]

const resultLines = [
  " RUN  v3.2.4 ~/projects/storefront",
  "",
  " ✓ src/checkout/cart.test.ts (12 tests) 41ms",
  " ✓ src/checkout/OrderTotal.test.tsx (6 tests) 88ms",
  " ✓ src/checkout/OrderSummary.test.tsx (5 tests) 102ms",
  " ✓ src/checkout/shipping.test.ts (9 tests) 23ms",
  " ✓ src/payments/card.test.ts (14 tests) 64ms",
  "",
  " Test Files  5 passed (5)",
  "      Tests  46 passed (46)",
  "   Duration  842ms",
]

// What each storefront terminal holds, by its id in the agents demo.
export const storefrontArtifacts: Readonly<Record<string, readonly SampleArtifact[]>> = {
  // Checkout implementation
  "01": [
    orderSummary,
    file("storefront-summary", "src/checkout/OrderSummary.tsx", summaryLines, { from: 6, to: 18 }),
    file("storefront-copy", "docs/checkout-copy.md", copyLines),
  ],
  // Tests
  "03": [file("storefront-results", "test-results.txt", resultLines)],
  // Checkout review
  "04": [
    file("storefront-spec", "e2e/checkout.spec.ts", specLines, { from: 11, to: 15 }),
    file("storefront-review", "review-notes.md", reviewLines),
    emptyCart,
  ],
}

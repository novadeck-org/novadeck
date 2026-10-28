import type { Conversations } from "@novadeck/core/conversation"
import type { InboxRow } from "@novadeck/core/inbox"
import { itemIdOf, type Item } from "@novadeck/core/items"
import type { Backend, BackendSink, TerminalKey } from "@novadeck/core/port"
import type { WorkspaceSeed } from "@novadeck/core/seed"
import { sessionName } from "@novadeck/core/session-name"
import type { CanvasLayout, TerminalMetadata, Workspace } from "@novadeck/core/types"

import {
  agentTerminal,
  declined,
  deskIntroOf,
  deskKey,
  deskMessages,
  deskTranscripts,
  project,
  session,
  slot,
  working,
  type Job,
} from "./desk"
import { demoHandle } from "./handles"
import { isDemoInbox } from "./inbox"
import { createDemoMessages } from "./messages"
import { demoTerminalId, terminalSlot, type ChatAgent } from "./samples"
import { ready, svg, type SampleArtifact } from "./showcase/artifacts"
import { add, context, file, hunk, remove } from "./showcase/changes"
import { createShowcase } from "./showcase/simulation"
import { terminalOf } from "./terminals"
import type { DemoTranscript } from "./transcripts"
import type { DemoTurns } from "./turns"

// The launch demo: the launch walkthrough video's tour of the app, captured from
// `?demo=launch`. A small software team's deck: project northwind, a web storefront, has ten
// agents on the Canvas, mixing Claude Code, Codex and Antigravity, all at work; a second
// project, northwind-docs, works beside it. The video's beats are cues the debug panel's
// "Launch" group fires (see `LaunchCues`), so a capture plan can time each to a frame: a
// spread of states, three asks that fill the Inbox, a lead that opens three teammates, a
// teammate's question to the person and the message it then sends its lead, a teammate's
// done, a page and then the changes (or a screenshot of three takes on a button) shown in the
// pane, and every agent finishing; and, for the website's /vs pages, a review one agent asks of
// another by message, and a plan shown in the pane. It shows
// nothing the app doesn't do: no cue draws over the app, it only has the agents act.

const shop = "northwind"
const docs = "northwind-docs"
const home = `/home/dev/projects/${shop}`

// The agents of northwind, by terminal number. The ones the cues act on:
export const launch = {
  // Asks to run its end-to-end tests.
  permission: 4,
  // Fails its turn.
  failing: 5,
  // Writes up a plan to approve.
  plan: 7,
  // Finishes alone, with a report, for the spread of states.
  finishes: 8,
  // Asks a question and marks its own pick.
  question: 1,
  // Shows a page, then its changes or a screenshot of three takes on a button, in the pane.
  shows: 9,
  // Opens the teammates, numbered after it.
  lead: 10,
  // The teammate that finishes first, reporting done.
  reports: 11,
  // The teammate that asks the person what only its lead knows.
  asking: 13,
  // Asks another agent, by message, to review its change; the reviewer answers.
  reviews: 1,
  reviewer: 2,
} as const

const jobs: readonly Job[] = [
  {
    name: "Cart drawer",
    agent: "claude",
    ask: "Add a cart drawer that opens from the header.",
    plan: "Wiring the drawer to the cart store, then checking it on a phone.",
    command: "pnpm build",
    progress: "Built 14 of 22 routes",
    done: "The cart drawer opens from the header and keeps its items.",
  },
  {
    name: "Search index",
    agent: "codex",
    ask: "Index the product catalog for search.",
    plan: "Reading how products are stored.",
    command: "pnpm test --filter search",
    progress: "",
    done: "Search finds products by name and tag, and the filter tests pass.",
  },
  {
    name: "Product pages",
    agent: "agy",
    ask: "Make the product pages load their images lazily.",
    plan: "Measuring the pages before and after.",
    command: "pnpm lighthouse --product",
    progress: "Scored 3 of 8 pages",
    done: "Product images load as they scroll into view.",
  },
  {
    name: "Checkout tests",
    agent: "claude",
    ask: "Cover the checkout with end-to-end tests.",
    plan: "The first flow is written. Running it next.",
    command: "pnpm test:e2e --filter checkout",
    progress: "",
    done: "The checkout has end-to-end tests, and they pass.",
    // What it did first, so its Inbox sheet shows its steps above the ask.
    before: [
      {
        tool: "Write",
        input: {
          file_path: `${home}/e2e/checkout.spec.ts`,
          content: `test("pays for a cart", async ({ page }) => {\n  await page.goto("/cart")\n  await page.getByRole("button", { name: "Checkout" }).click()\n  await expect(page).toHaveURL(/orders/)\n})`,
        },
        arg: "e2e/checkout.spec.ts",
        title: "Wrote",
        result: `File created successfully at: ${home}/e2e/checkout.spec.ts`,
      },
      {
        tool: "Edit",
        input: {
          file_path: `${home}/playwright.config.ts`,
          old_string: `testDir: "tests"`,
          new_string: `testDir: "e2e"`,
        },
        arg: "playwright.config.ts",
        title: "Edited",
        result: `The file ${home}/playwright.config.ts has been updated successfully.`,
      },
      {
        tool: "Bash",
        input: { command: "pnpm typecheck" },
        arg: "pnpm typecheck",
        title: "Ran",
        result: "Done in 3.2s",
      },
    ],
  },
  {
    name: "Stripe webhooks",
    agent: "codex",
    ask: "Handle Stripe's payment webhooks.",
    plan: "Verifying the signature before reading the event.",
    command: "pnpm test --filter webhooks",
    progress: "",
    done: "Payment webhooks are verified and recorded.",
  },
  {
    name: "Image pipeline",
    agent: "agy",
    ask: "Resize the product images at build time.",
    plan: "Generating three sizes of each image.",
    command: "pnpm images:build",
    progress: "Resized 120 of 340 images",
    done: "Every product image is built in three sizes.",
  },
  {
    name: "Order emails",
    agent: "claude",
    ask: "Send the customer an email when an order ships.",
    plan: "Reading how orders change state.",
    command: "pnpm test --filter emails",
    progress: "",
    done: "A shipped order sends its email, and the tests pass.",
  },
  {
    name: "Inventory sync",
    agent: "codex",
    ask: "Sync stock counts from the warehouse feed.",
    plan: "Writing the job that reads the feed.",
    command: "pnpm test --filter inventory",
    progress: "",
    done: "Stock counts follow the warehouse feed, and the tests pass.",
  },
  {
    name: "Order status page",
    agent: "claude",
    ask: "Build the order status page.",
    plan: "Previewing the page on the dev server.",
    command: "pnpm dev",
    progress: "Ready on http://localhost:3000",
    done: "The order status page shows where an order is, step by step.",
  },
  {
    name: "Orders API",
    agent: "claude",
    ask: "Set up the API the storefront reads its orders, prices and stock from.",
    plan: "Splitting it into three endpoints, one teammate for each.",
    command: "pnpm api:dev",
    progress: "Listening on :8787",
    done: "The three endpoints answer, and the storefront reads from them.",
  },
]

// The three teammates the lead opens, numbered after its nine fellows: they ask, plan and run
// like the jobs, and are led by the lead.
const teammates: readonly Job[] = [
  {
    name: "Pricing endpoint",
    agent: "codex",
    ask: "Serve prices from the API.",
    plan: "Reading the price list into a route.",
    command: "pnpm test --filter pricing-api",
    progress: "",
    done: "The pricing endpoint answers.",
  },
  {
    name: "Stock endpoint",
    agent: "agy",
    ask: "Serve stock levels from the API.",
    plan: "Writing the route for stock.",
    command: "pnpm test --filter stock-api",
    progress: "Ran 2 of 6 checks",
    done: "The stock endpoint answers.",
  },
  {
    name: "Cart endpoint",
    agent: "claude",
    ask: "Keep the cart in the API.",
    plan: "Writing the route that saves a cart.",
    command: "pnpm test --filter cart-api",
    progress: "",
    done: "The cart endpoint saves and returns a cart.",
  },
]

// What the other project's agents are at.
const elsewhere: readonly (readonly [string, ChatAgent])[] = [
  ["API reference", "claude"],
  ["Changelog", "codex"],
  ["Getting started", "agy"],
]

const allJobs: readonly Job[] = [...jobs, ...teammates]

const keyOf = (number: number, projectId = shop): TerminalKey => deskKey(projectId, number)

// The Canvas: windows on a grid four across, each a little off the line as windows end up when
// moved by hand. The ten fill the first two rows and two places of the third, the lead (the
// tenth) the second of those, with the places right of it and under it empty for its three
// teammates. Each window's column and row, by its place in the list.
const cells = [
  [0, 0],
  [1, 0],
  [2, 0],
  [3, 0],
  [0, 1],
  [1, 1],
  [2, 1],
  [3, 1],
  [0, 2],
  [1, 2],
  // The teammates: beside the lead, and under it.
  [2, 2],
  [1, 3],
  [2, 3],
] as const
const nudges = [
  [0, 10],
  [25, -15],
  [-10, 20],
  [15, 0],
  [-20, 5],
  [10, 25],
  [0, -10],
  [-15, 15],
  [20, -5],
  [-5, 20],
  [5, 5],
  [-5, 10],
  [10, -5],
] as const
const place = (index: number) => {
  const [dx, dy] = nudges[index]!
  const [column, row] = cells[index]!
  return {
    position: { x: column * 610 + dx, y: row * 440 + dy },
    width: 550,
    height: 380,
  }
}
const deskLayout = (): CanvasLayout => ({
  viewport: { x: 120, y: 60, zoom: 0.5 },
  geometry: Object.fromEntries(
    jobs.map((_, index) => [
      demoTerminalId({ projectId: shop, workspaceSessionId: session }, index + 1),
      place(index),
    ]),
  ),
})

// The open session was visited just now; the others a while before.
const sessionOf = (
  now: number,
  terminals: TerminalMetadata[],
  canvasLayout?: CanvasLayout,
  visitedAt = now,
) => ({
  id: session,
  name: sessionName(now),
  visitedAt,
  terminals,
  items: [],
  windows: [],
  ...(canvasLayout && { canvasLayout }),
})

// The storefront's project first, which the demo's transcripts and screens belong to.
export const launchSeed = (now: number): WorkspaceSeed => ({
  projects: [
    {
      ...project(shop),
      sessions: [
        sessionOf(
          now,
          jobs.map((job, index) => agentTerminal(shop, index + 1, job.name, job.agent, working)),
          deskLayout(),
        ),
      ],
    },
    {
      ...project(docs),
      sessions: [
        sessionOf(
          now,
          elsewhere.map(([name, agent], index) =>
            agentTerminal(docs, index + 1, name, agent, working),
          ),
          undefined,
          now - 20 * 60_000,
        ),
      ],
    },
  ],
})

// What each conversation holds so far. Three agents also hold what they'll ask when the cues
// come: the checkout tests a permission, the order emails a plan, the cart drawer a question
// with its own pick.
export const launchTranscripts = (now: number): Readonly<Record<string, DemoTranscript>> =>
  deskTranscripts(
    now,
    allJobs,
    home,
    {
      permission: launch.permission,
      plan: {
        number: launch.plan,
        subject: "Order emails plan",
        steps:
          "1. Add a shipped-order email template\n2. Queue it when an order is marked shipped\n3. Test it with a sandbox order",
      },
      question: {
        number: launch.question,
        id: "cart",
        header: "Cart",
        question: "Where should the cart be kept between visits?",
        options: [
          {
            id: "account",
            label: "In the customer's account (Recommended)",
            description: "Follows them across devices, with a cookie for guests.",
          },
          {
            id: "browser",
            label: "In the browser only",
            description: "Simple, but a new device starts with an empty cart.",
          },
          {
            id: "session",
            label: "In the server session",
            description: "No storage in the browser, but it expires with the session.",
          },
        ],
      },
    },
    promptOf,
  )

// A teammate's agent starts on Novadeck's doorbell notice, which it answers by reading the brief
// its lead sent it: the person never typed its task.
const noticeOf = (number: number): string =>
  `[Novadeck: automatic notice, agent messages waiting, ${["Q7mT2c", "R4kW9x", "H2nB6p"][number - jobs.length - 1]}]`
const promptOf = (number: number, job: Job): string =>
  number > jobs.length ? noticeOf(number) : job.ask

export const launchIntroOf = deskIntroOf(shop, allJobs, promptOf)

// The page the order-status agent shows in the pane: its dev server's, as a snapshot. A
// page half built: the layout and the timeline are in, the tracking map is still a placeholder.
const paper = "#f7f8fa"
const ink = "#111827"
const muted = "#6b7280"
const rule = "#e5e7eb"
const accent = "#2563eb"
const sans = 'font-family="Helvetica, Arial, sans-serif"'
const mono = 'font-family="Menlo, Consolas, monospace"'
// The page 800 by 584, the shape of the pane beside its window in the 1280x720 window the
// launch video is captured in, so the pane is filled there (elsewhere it scrolls or leaves a band).
const page = (body: string): string => svg(1600, 1168, body, 584)
const step = (x: number, label: string, at: string, reached: boolean, current: boolean): string =>
  `<circle cx="${x}" cy="232" r="9" fill="${reached ? accent : "#ffffff"}" stroke="${reached ? accent : "#cbd5e1"}" stroke-width="2"/>` +
  (current
    ? `<circle cx="${x}" cy="232" r="15" fill="none" stroke="${accent}" opacity=".35"/>`
    : "") +
  `<text x="${x}" y="266" ${sans} font-size="13" font-weight="700" fill="${reached ? ink : muted}" text-anchor="middle">${label}</text>` +
  `<text x="${x}" y="284" ${sans} font-size="11" fill="${muted}" text-anchor="middle">${at}</text>`
const line = (name: string, quantity: string, price: string, y: number): string =>
  `<text x="56" y="${y}" ${sans} font-size="14" fill="${ink}">${name}</text>` +
  `<text x="360" y="${y}" ${sans} font-size="14" fill="${muted}" text-anchor="end">${quantity}</text>` +
  `<text x="440" y="${y}" ${sans} font-size="14" font-weight="700" fill="${ink}" text-anchor="end">${price}</text>` +
  `<line x1="56" y1="${y + 14}" x2="440" y2="${y + 14}" stroke="${rule}"/>`
const previewArtifact = (): SampleArtifact => ({
  item: {
    id: "northwind-order-preview",
    kind: "page",
    name: "localhost:3000",
    // A page's detail is its address, as the runner writes it.
    detail: "http://localhost:3000/orders/1042",
    path: null,
    url: "http://localhost:3000/orders/1042",
    lines: null,
    secret: false,
  },
  content: ready({
    kind: "page",
    url: "http://localhost:3000/orders/1042",
    shown: 1,
    live: false,
    snapshot: page(
      `<rect width="800" height="584" fill="${paper}"/>` +
        `<rect width="800" height="60" fill="#ffffff"/>` +
        `<line x1="0" y1="60" x2="800" y2="60" stroke="${rule}"/>` +
        `<rect x="56" y="20" width="20" height="20" rx="5" fill="${accent}"/>` +
        `<text x="86" y="37" ${sans} font-size="19" font-weight="700" fill="${ink}">Northwind</text>` +
        `<text x="520" y="35" ${sans} font-size="13" fill="${muted}">Shop</text>` +
        `<text x="572" y="35" ${sans} font-size="13" fill="${muted}">Orders</text>` +
        `<text x="640" y="35" ${sans} font-size="13" fill="${muted}">Account</text>` +
        `<text x="56" y="108" ${sans} font-size="11" font-weight="700" letter-spacing="2" fill="${accent}">ORDER 1042</text>` +
        `<text x="56" y="148" ${sans} font-size="30" font-weight="700" fill="${ink}">Your order is on its way</text>` +
        `<text x="56" y="174" ${sans} font-size="13" fill="${muted}">Placed Tuesday, shipped Thursday. Arrives by Monday.</text>` +
        `<line x1="110" y1="232" x2="690" y2="232" stroke="#cbd5e1" stroke-width="2"/>` +
        `<line x1="110" y1="232" x2="430" y2="232" stroke="${accent}" stroke-width="2"/>` +
        step(110, "Placed", "Tue 9:41", true, false) +
        step(270, "Packed", "Wed 14:05", true, false) +
        step(430, "Shipped", "Thu 8:12", true, true) +
        step(690, "Delivered", "Mon", false, false) +
        `<text x="56" y="340" ${sans} font-size="11" font-weight="700" letter-spacing="2" fill="${accent}">IN THIS ORDER</text>` +
        line("Canvas tote, natural", "×1", "$38.00", 372) +
        line("Enamel mug, 350 ml", "×2", "$32.00", 408) +
        line("Notebook, dotted", "×3", "$27.00", 444) +
        `<text x="56" y="486" ${sans} font-size="14" font-weight="700" fill="${ink}">Total</text>` +
        `<text x="440" y="486" ${sans} font-size="14" font-weight="700" fill="${ink}" text-anchor="end">$97.00</text>` +
        // The tracking map, not in yet: the layout's placeholder.
        `<rect x="490" y="340" width="254" height="150" rx="10" fill="#eef1f6" stroke="#cbd5e1" stroke-dasharray="6 5"/>` +
        `<line x1="490" y1="340" x2="744" y2="490" stroke="#dde3ec"/>` +
        `<line x1="744" y1="340" x2="490" y2="490" stroke="#dde3ec"/>` +
        `<rect x="552" y="403" width="130" height="24" rx="4" fill="${paper}"/>` +
        `<text x="617" y="419" ${mono} font-size="11" fill="${muted}" text-anchor="middle">tracking-map.tsx</text>`,
    ),
  }),
})

// Then the agent's three takes on the page's Track package button, which the page still lacks,
// as a screenshot of them side by side for the person to pick from.
const button = (x: number, label: string, take: string, note: string, face: string): string =>
  `<rect x="${x}" y="112" width="232" height="262" rx="12" fill="#ffffff" stroke="${rule}"/>` +
  `<text x="${x + 22}" y="146" ${sans} font-size="11" font-weight="700" letter-spacing="2" fill="${accent}">${label}</text>` +
  `<text x="${x + 22}" y="170" ${sans} font-size="15" font-weight="700" fill="${ink}">${take}</text>` +
  face +
  `<text x="${x + 116}" y="340" ${sans} font-size="12" fill="${muted}" text-anchor="middle">${note}</text>`
const variantsArtifact = (): SampleArtifact => ({
  item: {
    id: "northwind-track-button",
    kind: "image",
    name: "track-button.png",
    detail: "1600 × 900 PNG",
    path: `${home}/screenshots/track-button.png`,
    url: null,
    lines: null,
    secret: false,
  },
  content: ready({
    kind: "image",
    src: svg(
      1600,
      900,
      `<rect width="800" height="450" fill="${paper}"/>` +
        `<text x="40" y="58" ${sans} font-size="11" font-weight="700" letter-spacing="2" fill="${accent}">ORDER 1042 · TRACK PACKAGE</text>` +
        `<text x="40" y="88" ${sans} font-size="22" font-weight="700" fill="${ink}">Three takes on the button</text>` +
        button(
          40,
          "A",
          "Solid",
          "The page's one strong action",
          `<rect x="66" y="222" width="180" height="46" rx="8" fill="${accent}"/>` +
            `<text x="156" y="251" ${sans} font-size="15" font-weight="700" fill="#ffffff" text-anchor="middle">Track package</text>`,
        ) +
        button(
          284,
          "B",
          "Outline",
          "Quieter beside the timeline",
          `<rect x="310" y="222" width="180" height="46" rx="8" fill="#ffffff" stroke="${accent}" stroke-width="2"/>` +
            `<text x="400" y="251" ${sans} font-size="15" font-weight="700" fill="${accent}" text-anchor="middle">Track package</text>`,
        ) +
        button(
          528,
          "C",
          "With the carrier",
          "Says who has it and when",
          `<rect x="554" y="214" width="180" height="62" rx="8" fill="${accent}"/>` +
            `<text x="644" y="240" ${sans} font-size="15" font-weight="700" fill="#ffffff" text-anchor="middle">Track package</text>` +
            `<text x="644" y="260" ${sans} font-size="11" fill="#dbeafe" text-anchor="middle">UPS · arrives Monday</text>`,
        ),
    ),
  }),
})

// What the same agent has changed in the project to get there, shown as the pane shows an
// agent's whole change: the working tree against HEAD, file by file.
const changesRoot = home
const changesArtifact = (): SampleArtifact => ({
  item: {
    id: "northwind-order-changes",
    kind: "changes",
    // As the runner names a change: its folder, and its totals (`describeChange`).
    name: "Changes · northwind",
    detail: "3 files · +23 −1",
    path: changesRoot,
    url: null,
    lines: null,
    secret: false,
  },
  content: ready({
    kind: "changes",
    root: changesRoot,
    base: "HEAD",
    truncated: false,
    files: [
      file("src/app/orders/[id]/page.tsx", "added", [
        hunk(0, 1, [
          add('import { OrderTimeline } from "@/components/OrderTimeline"'),
          add('import { getOrder } from "@/lib/orders"'),
          add(""),
          add("export default async function OrderPage({ params }: { params: { id: string } }) {"),
          add("  const order = await getOrder(params.id)"),
          add("  return <OrderTimeline steps={order.steps} />"),
          add("}"),
        ]),
      ]),
      file("src/components/OrderTimeline.tsx", "added", [
        hunk(0, 1, [
          add("export const OrderTimeline = ({ steps }: { steps: Step[] }) => ("),
          add('  <ol className="timeline">'),
          add("    {steps.map((step) => ("),
          add("      <li key={step.name} data-reached={step.at !== null}>{step.name}</li>"),
          add("    ))}"),
          add("  </ol>"),
          add(")"),
        ]),
      ]),
      file("src/lib/orders.ts", "modified", [
        hunk(12, 12, [
          context("export const getOrder = async (id: string) => {"),
          context("  const order = await db.orders.find(id)"),
          remove("  return order"),
          add("  return { ...order, steps: stepsOf(order) }"),
          context("}"),
        ]),
        hunk(30, 30, [
          context("const placed = (order: Order) => order.placedAt"),
          add(""),
          add("// Placed, packed, shipped, delivered: the ones with a time have been reached."),
          add("const stepsOf = (order: Order) => ["),
          add('  { name: "Placed", at: order.placedAt },'),
          add('  { name: "Packed", at: order.packedAt },'),
          add('  { name: "Shipped", at: order.shippedAt },'),
          add('  { name: "Delivered", at: order.deliveredAt },'),
          add("]"),
        ]),
      ]),
    ],
  }),
})

// The question the asking teammate puts to the person, and to its lead too, as the `ask` tool
// has it do: the lead knows the answer.
const teammateAskId = "launch-teammate-ask"
const question = {
  subject: "Which API version does the storefront call?",
  body: "The cart route has to match what the storefront sends. I can't tell from the code whether it calls v1 or v2, and I'd rather not guess.",
} as const
const leadsAnswer = "The storefront calls v2, on port 8787. v1 is retired."
const teammateAsk = (number: number, now: number): InboxRow => {
  const job = allJobs[number - 1]!
  return {
    id: teammateAskId,
    source: {
      projectId: shop,
      workspaceSessionId: session,
      terminalId: demoTerminalId({ projectId: shop, workspaceSessionId: session }, number),
      handle: demoHandle(number),
      agent: job.agent,
      title: job.name,
      projectName: shop,
    },
    at: now,
    stopped: false,
    seen: false,
    kind: "ask",
    ask: { ...question, details: null, hardToUndo: null, shape: { type: "text" } },
  }
}

// The review one agent asks of another, and the reviewer's answer.
const reviewAsk =
  "Can you review my cart drawer change? It's in src/components/CartDrawer.tsx and the header's cart button."
const reviewAnswer =
  "Reviewed. One thing to fix: the drawer doesn't trap focus, so Tab moves to the page behind it. The rest reads well, and the open and close are smooth."

// The plan the plan's agent writes, in the file Claude Code keeps its plans in.
const planPath = "/home/dev/.claude/plans/order-emails.md"
const planText = [
  "# Order emails",
  "",
  "Email the customer when their order ships, with the same timeline as the order page.",
  "",
  "## Steps",
  "",
  "1. Add a shipped-order email template, `emails/shipped.tsx`",
  "2. Queue it when an order is marked shipped",
  "3. Test it with a sandbox order",
  "",
  "## Open questions",
  "",
  "- Send it from the store's address, or a no-reply one?",
].join("\n")
const planArtifact = (): SampleArtifact => ({
  item: {
    id: "northwind-order-emails-plan",
    kind: "plan",
    name: "Order emails",
    detail: planPath,
    path: planPath,
    url: null,
    lines: null,
    secret: false,
    plan: { agent: "Claude Code", role: "root", source: "file" },
  },
  content: ready({ kind: "plan", text: planText, truncated: false, writable: true, skill: false }),
})

// How long the lead takes to answer its teammate once the doorbell rang it awake.
// (long enough for a capture to show the teammate's ask on its own first)
const answersMs = 4000

// How far apart the agents finish, so the Canvas turns green in a ripple.
const rippleMs = 60
const finishesAfterMs = 200

// The video's beats, one cue each, for the debug panel's "Launch" group to fire at the frame a
// capture wants (see `launchGroups`). Each does nothing twice, nor before it can: a cue
// already fired, one whose ground isn't there yet (the teammate's ask before the teammates
// open), or one whose agent has ended its turn since `finishAll`, is ignored. `finishAll` leaves
// an agent waiting on the person to wait, as it would: the cues that make it ask are for the
// person to answer first.
export type LaunchCues = {
  // One agent asks to run its tests, one fails its turn and one finishes with a report: the
  // marks the windows and tabs show for asking, failed and done, beside all that work.
  readonly states: () => void
  // A permission ("Run `pnpm test:e2e`?"), a plan to approve and a question with the agent's
  // pick, all at once: the Inbox's badge reads 3. Each can be rung alone.
  readonly asks: () => void
  readonly permission: () => void
  readonly plan: () => void
  readonly question: () => void
  // One agent's turn ends in an error: a Trouble row, and its line goes red.
  readonly fail: () => void
  // One agent ends its turn with a report: a done mark and an Update row.
  readonly finishOne: () => void
  // The lead opens three teammates, which its team wire draws to, and rests while they work.
  // Each starts on the doorbell's notice, and its lead's brief arrives as a message.
  readonly teammates: () => void
  // A teammate asks the person what only its lead knows, and messages the lead the same
  // question at once. The ask shows as an Inbox row; the idle lead, rung awake, works and
  // answers: the answer is sent about 5 s after the cue and lands about 0.8 s later, which is
  // when the teammate acts on it and withdraws its ask: the row stays, settled, "Withdrawn". The person types nothing.
  readonly teammateAsks: () => void
  // A teammate ends its turn with its done report (a done mark and an Update row) and sends the
  // same report to its lead, as a message: the lead is rung.
  readonly teammateDone: () => void
  // The order-status agent shows its page in the pane beside its window, then its changes, as
  // diffs, or its three takes on the page's Track package button, as a screenshot.
  readonly show: () => void
  readonly showChanges: () => void
  readonly showVariants: () => void
  // An agent asks another to review its change, by message (Cart drawer asks Search index), and
  // the reviewer, rung awake, answers about 4 s later. The exchange reads in either one's
  // Messages pane.
  readonly askReview: () => void
  // The plan's agent shows its plan, the file it writes it in, in the pane beside its window.
  readonly showPlan: () => void
  // Every agent of both projects ends its turn, one after another, but the ones still waiting
  // on the person: an unanswered request, or a teammate and its lead while their exchange is
  // on its way (they finish when it settles). Each teammate messages its lead its report as it
  // finishes, and the lead finishes after those reach it (about 1 s on).
  readonly finishAll: () => void
}

const cuesOf = new WeakMap<Backend, LaunchCues>()

/** The cues of a backend `createLaunch` made, however wrapped. Nothing for any other. */
export const launchCuesOf = (backend: Backend): LaunchCues | undefined => cuesOf.get(backend)

// The agent is at work and waits on nothing: the one state a cue may take on.
const busy = (found: TerminalMetadata | undefined): found is TerminalMetadata =>
  found?.state === "running" && found.agent?.working === true && !found.agent.attention

// The launch demo's parts, for `plainDemo` to put round the demo's own: `under` the
// conversations (the seed, its messages, its pane, and a view of the workspace and the sink),
// `wrap` round them (an agent that is answered or told goes back to work, and works until it
// finishes), and `over` the whole (the cues).
export const createLaunch = (turns: DemoTurns, now: number) => {
  // Built here, not at the top of the module: the try demo bundles this module without running it.
  const asking = demoHandle(launch.asking)
  const reporting = demoHandle(launch.reports)
  const lead = demoHandle(launch.lead)
  const preview = previewArtifact()
  const changes = changesArtifact()
  const variants = variantsArtifact()
  const plan = planArtifact()
  const messages = createDemoMessages([deskMessages(shop, allJobs.length)], false, (target, id) =>
    latest === undefined ? true : terminalOf(latest, { ...target, terminalId: id }) !== undefined,
  )
  const showcase = createShowcase({
    agents: [],
    shown: [
      {
        key: keyOf(launch.shows),
        handle: demoHandle(launch.shows),
        artifacts: [preview, changes, variants],
      },
      { key: keyOf(launch.plan), handle: demoHandle(launch.plan), artifacts: [plan] },
    ],
  })
  let latest: Workspace | undefined
  let sink: BackendSink | undefined
  const target = { projectId: shop, workspaceSessionId: session }
  const terminal = (number: number): TerminalMetadata | undefined =>
    terminalOf(latest, keyOf(number))

  const work = (key: TerminalKey): void => {
    const found = terminalOf(latest, key)
    if (found?.state === "running" && found.agent) turns.work(key, found)
  }
  // Rings an agent awake if it rests: one already at work is left to it.
  const wake = (key: TerminalKey): void => {
    // Not once the demo stopped, nor for an agent `finishAll` ended.
    if (!sink || rippled.has(key.terminalId)) return
    const found = terminalOf(latest, key)
    if (found?.state === "running" && found.agent && !found.agent.working) work(key)
  }

  // A cue that acts on one terminal's agent, if it's there and at work.
  const on = (
    number: number,
    act: (key: TerminalKey, found: TerminalMetadata) => void,
  ): boolean => {
    const found = terminal(number)
    if (!busy(found)) return false
    act(keyOf(number), found)
    return true
  }
  const asked = new Set<string>()
  const ask = (number: number, kind: "permission" | "plan" | "question"): void => {
    if (asked.has(kind)) return
    on(number, (key, found) => {
      asked.add(kind)
      turns.ask(key, found, kind, 1)
    })
  }
  // The agents the person told no, or whose words they took without going on, or that ended
  // a turn a cue of its own chose: they wait at their prompt, and no cue ends a turn for them.
  const resting = new Set<string>()
  // The agents `finishAll`'s ripple has ended (or has begun to), which it never ends twice.
  const rippled = new Set<string>()
  const shown = new Set<string>()
  let opened = false
  let teammateAsked = false
  let reviewAsked = false
  let failed = false
  let finished = false
  let reported = false
  // Once `finishAll` ran, no cue starts an agent's turn again.
  let ended = false
  // Whether the teammate and its lead have had their exchange out: the lead's answer landed, or
  // a stop ended it.
  let exchanged = false
  // The exchange is out: if everyone finished meanwhile, those it held finish now.
  const settle = (): void => {
    if (exchanged) return
    exchanged = true
    if (ended) ripple()
  }

  const cues: LaunchCues = {
    permission: () => !ended && ask(launch.permission, "permission"),
    plan: () => !ended && ask(launch.plan, "plan"),
    question: () => !ended && ask(launch.question, "question"),
    asks: () => {
      cues.permission()
      cues.plan()
      cues.question()
    },
    fail: () => {
      if (failed || ended) return
      failed = on(launch.failing, (key, found) => {
        resting.add(found.id)
        // As Codex records a turn the API cut short: its `task_complete` carries the error, and
        // the agent said nothing. The message is the one harnesses/codex/src/failures.test.ts
        // uses for such a turn.
        turns.finish(key, found, "failed", { after: finishesAfterMs, error: "stream disconnected" })
      })
    },
    finishOne: () => {
      if (finished || ended) return
      const job = jobs[launch.finishes - 1]!
      finished = on(launch.finishes, (key, found) => {
        resting.add(found.id)
        turns.finish(key, found, "completed", {
          after: finishesAfterMs,
          reply: job.done,
          done: { subject: `${job.name} is done`, body: job.done },
        })
      })
    },
    states: () => {
      cues.permission()
      cues.fail()
      cues.finishOne()
    },
    teammates: () => {
      // Its lead has to be there, and at work, to open them.
      if (opened || ended || !sink || !busy(terminal(launch.lead))) return
      opened = true
      sink.dispatch(
        teammates.map((job, index) => ({
          type: "terminal/add" as const,
          target,
          terminal: agentTerminal(
            shop,
            jobs.length + index + 1,
            job.name,
            job.agent,
            working,
            lead,
            true,
          ),
          // At the desk's window size, in the places beside and under the lead, wherever the
          // person's selection is.
          canvasGeometry: place(jobs.length + index),
          anchor: keyOf(launch.lead).terminalId,
          select: false,
        })),
      )
      // Each teammate's brief, from its lead, which its first turn reads.
      teammates.forEach((job, index) =>
        messages.send(target, lead, demoHandle(jobs.length + index + 1), job.ask),
      )
      on(launch.lead, (key, found) => turns.rest(key, found))
    },
    teammateAsks: () => {
      // Its teammate has to be there, and at work, to ask.
      if (teammateAsked || ended || !opened) return
      const inbox = backendInbox()
      if (!inbox) return
      if (!on(launch.asking, () => undefined)) return
      teammateAsked = true
      inbox.add(teammateAsk(launch.asking, Date.now()))
      // And its lead, so it knows what the teammate waits on; the rung lead answers.
      const sent = messages.send(
        target,
        asking,
        lead,
        `${question.subject} ${question.body}`,
        () => {
          wake(keyOf(launch.lead))
          // The lead answers unless the person took it some other way meanwhile, as Escape does.
          const epoch = turns.epoch(keyOf(launch.lead))
          setTimeout(() => {
            if (!sink) return
            if (turns.epoch(keyOf(launch.lead)) !== epoch) {
              settle()
              return
            }
            const replied = messages.send(
              target,
              lead,
              asking,
              leadsAnswer,
              // Its lead answered first: the teammate acts on that, and withdraws its ask.
              () => {
                backendInbox()?.resolve(teammateAskId, "withdrawn")
                // An agent the ripple ended is not taken back to work by a late answer.
                if (!rippled.has(keyOf(launch.asking).terminalId)) work(keyOf(launch.asking))
                settle()
              },
              () => {
                settle()
              },
            )
            if (!replied) settle()
          }, answersMs)
        },
        () => {
          settle()
        },
      )
      // Refused, as the lead closed: nothing is on its way to wait for.
      if (!sent) settle()
    },
    teammateDone: () => {
      if (reported || ended || !opened) return
      const job = allJobs[launch.reports - 1]!
      reported = on(launch.reports, (key, found) => {
        resting.add(found.id)
        // With a lead, `done` is called all the same, and the report goes to the lead too, as a
        // message: the lead is rung, if it rests.
        turns.finish(key, found, "completed", {
          after: finishesAfterMs,
          reply: job.done,
          done: { subject: `${job.name} is done`, body: job.done },
        })
        messages.send(target, reporting, lead, `Done. ${job.done}`, () => {
          if (!ended) wake(keyOf(launch.lead))
        })
      })
    },
    show: () => upsert(preview),
    showChanges: () => upsert(changes),
    showVariants: () => upsert(variants),
    askReview: () => {
      if (reviewAsked || ended || !busy(terminal(launch.reviews)) || !terminal(launch.reviewer))
        return
      const from = demoHandle(launch.reviews)
      const to = demoHandle(launch.reviewer)
      reviewAsked = messages.send(target, from, to, reviewAsk, () => {
        wake(keyOf(launch.reviewer))
        setTimeout(() => {
          if (!sink || ended) return
          messages.send(target, to, from, reviewAnswer, () => wake(keyOf(launch.reviews)))
        }, answersMs)
      })
    },
    showPlan: () => upsert(plan, launch.plan),
    finishAll: () => {
      if (!latest) return
      ended = true
      ripple()
    },
  }

  // An agent shows something in the pane, as the show tool does: the order-status agent its page,
  // then its changes, the plan's agent its plan, each on its own bar. Each is shown once.
  const upsert = (artifact: SampleArtifact, number: number = launch.shows): void => {
    if (!sink || shown.has(artifact.item.id) || !busy(terminal(number))) return
    shown.add(artifact.item.id)
    const holder = keyOf(number)
    const item: Item = {
      id: itemIdOf(artifact.item.id),
      holder: { terminalId: holder.terminalId },
      kind: artifact.item.kind,
      name: artifact.item.name,
      detail: artifact.item.detail,
      path: artifact.item.path,
      url: artifact.item.url,
      lines: null,
      secret: false,
      by: "agent",
      from: { terminalId: holder.terminalId, handle: demoHandle(number) },
      version: 1,
      // The agent opens it for the person, as the show tool does.
      openAsked: true,
      shownAt: Date.now(),
      plan: artifact.item.plan ?? null,
    }
    sink.dispatch([{ type: "item/upsert", target: holder, item }])
  }

  // The final backend's Inbox, which the cues add the teammate's ask to.
  let inboxOf: (() => Backend["inbox"]) | undefined
  const backendInbox = () => {
    const inbox = inboxOf?.()
    return isDemoInbox(inbox) ? inbox : undefined
  }

  // Whether `finishAll` leaves an agent as it is: it ended its turn already (a failed one stays
  // failed until the person prompts it again, which takes it back to work), it waits on a
  // request, was told no, or it is the teammate whose question is out or the lead that is to
  // answer it: neither can say what it hasn't been asked.
  const waitsOnPerson = (found: TerminalMetadata): boolean => {
    if (found.state !== "running") return true
    const { agent } = found
    if (agent?.attention || resting.has(found.id)) return true
    if (agent?.lastTurn && !agent.working) return true
    if (!teammateAsked || exchanged) return false
    return (
      found.id === keyOf(launch.asking).terminalId || found.id === keyOf(launch.lead).terminalId
    )
  }

  // The lead's own turn ends once its teammates' reports have reached it, or were dropped.
  const reports = new Set<string>()
  const leadKey = keyOf(launch.lead)
  const finishLead = (): void => {
    if (!sink || !ended || reports.size > 0 || rippled.has(leadKey.terminalId)) return
    const found = terminalOf(latest, leadKey)
    if (!found || waitsOnPerson(found)) return
    rippled.add(leadKey.terminalId)
    const job = jobs[launch.lead - 1]!
    turns.finish(leadKey, found, "completed", {
      after: finishesAfterMs,
      reply: job.done,
      done: { subject: `${job.name} is done`, body: job.done },
    })
  }

  // Ends the turn of every agent of both projects that waits on nothing, one after another, so
  // the Canvas turns green in a ripple. A teammate reports to its lead as it finishes, with a
  // message, and the lead finishes after those reach it.
  const ripple = (): void => {
    if (!latest || !sink) return
    let count = 0
    for (const each of latest.projects)
      for (const history of each.history)
        for (const found of history.state.roster.terminals) {
          if (found.state !== "running") continue
          const key = {
            projectId: each.id,
            workspaceSessionId: history.id,
            terminalId: found.id,
          }
          if (rippled.has(found.id) || waitsOnPerson(found)) continue
          if (opened && found.id === leadKey.terminalId) continue
          rippled.add(found.id)
          const number = each.id === shop ? Number(terminalSlot(found.id)) : 0
          const job = number ? allJobs[number - 1] : undefined
          const text = job?.done ?? "Done. Everything is in, and the checks pass."
          turns.finish(key, found, "completed", {
            after: finishesAfterMs + count * rippleMs,
            reply: text,
            done: { subject: `${job?.name ?? found.name} is done`, body: text },
          })
          count += 1
          if (number <= jobs.length) continue
          reports.add(found.id)
          const release = (): void => {
            if (!sink) return
            reports.delete(found.id)
            finishLead()
          }
          const sent = messages.send(
            target,
            demoHandle(number),
            lead,
            `Done. ${text}`,
            release,
            release,
          )
          if (!sent) release()
        }
    // With teammates, the lead ends after their reports reach it; alone, it ended in its place.
    if (opened) finishLead()
  }

  // The person answers the teammate's ask from the Inbox before its lead does: the answer
  // reaches the teammate, which goes on with it, and the lead's later answer withdraws nothing.
  const answerEntry = `answer:${teammateAskId}`
  messages.state.subscribe(() => {
    if (exchanged) return
    const entry = Object.values(messages.state.getSnapshot().terminals)
      .flatMap((each) => each.threads)
      .flatMap((thread) => thread.messages)
      .find((each) => each.id === answerEntry && each.state === "delivered")
    if (!entry) return
    work(keyOf(launch.asking))
    settle()
  })

  return {
    transcripts: launchTranscripts(now),
    // The seed with its messages and pane, and a view of the workspace and the sink.
    under: (backend: Backend): Backend => ({
      ...backend,
      seed: launchSeed(now),
      messages,
      companions: showcase,
      commit: (workspace, actions) => {
        latest = workspace
        backend.commit(workspace, actions)
        // A terminal that closed turns what waits for it into gone messages.
        messages.refresh()
      },
      start: (next) => {
        sink = next
        const stop = backend.start?.(next)
        return () => {
          stop?.()
          if (sink === next) sink = undefined
        }
      },
    }),
    // An agent that has been answered or told goes back to work, and works until the cue that
    // finishes it: unless it was told no, and waits for the person.
    wrap: (conversations: Conversations): Conversations => ({
      ...conversations,
      send: async (key, text) => {
        await conversations.send(key, text)
        // Prompted again, it is at work, and `finishAll` ends its turn like any other's.
        resting.delete(key.terminalId)
        work(key)
      },
      answer: async (key, request, answer) => {
        // Claude Code's plan dialog takes words only in its third option, which needs them
        // (harnesses/claude's dialogs refuse the others, as dialogs.test.ts has it).
        if (request === `${slot(launch.plan)}:plan` && answer.type === "choice") {
          const words = (answer.text ?? "").trim() !== ""
          if (answer.option === "3" ? !words : words)
            throw new Error("Couldn't answer that here. Answer it in the terminal.")
        }
        await conversations.answer(key, request, answer)
        // Told no, or chatting about a question without words: it waits for the person's next
        // words, and no cue ends a turn for it.
        if (declined(answer)) {
          resting.add(key.terminalId)
          return
        }
        resting.delete(key.terminalId)
        work(key)
      },
    }),
    // The cues belong to the backend returned, and add to its Inbox.
    over: (backend: Backend): Backend => {
      inboxOf = () => backend.inbox
      cuesOf.set(backend, cues)
      return backend
    },
  }
}

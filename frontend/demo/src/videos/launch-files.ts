import type { FilesProject, TouchedFile } from "@novadeck/core/files"

import type { FilesScene, Pool } from "../files"
import { demoHandle } from "../handles"
import { demoTerminalId } from "../samples"

// The launch demo's Files panel (`?demo=launch`): project northwind's tree, and the agents on the
// deck that write in it while they work, each in the files its own screen says it is at. The
// panel is behind a flag (`launchFiles`): it adds a Files button to the rail, which no other
// beat of the video shows. Nothing is written until the cue says (`DemoFiles.release`), so the
// panel opens still and then the tree changes in front of the camera.

const project = "northwind"
const session = { projectId: project, workspaceSessionId: "initial" }

/** Whether the launch demo offers the Files panel: asked by `&files=on`, or by the debug panel. */
export const launchFiles = { on: false }

// The agents that write, by the number of their terminal on the deck, and the files each keeps
// coming back to and the ones it creates (each the first time only).
const writers: readonly (readonly [number, Pool])[] = [
  [
    1,
    {
      files: [
        "src/components/CartDrawer.tsx",
        "src/components/Header.tsx",
        "src/cart/useCart.ts",
        "src/components/CartDrawer.test.tsx",
      ],
      fresh: ["src/components/CartButton.tsx"],
    },
  ],
  [
    2,
    {
      files: ["api/search/index.ts", "api/search/tokenize.ts"],
      fresh: ["api/search/index.test.ts"],
    },
  ],
  [
    4,
    {
      files: ["e2e/checkout.spec.ts", "playwright.config.ts"],
      fresh: ["e2e/cart.spec.ts"],
    },
  ],
  [
    5,
    {
      files: ["api/webhooks/stripe.ts", "api/webhooks/stripe.test.ts", "src/lib/stripe.ts"],
      fresh: ["api/webhooks/events.ts"],
    },
  ],
  [
    7,
    {
      files: ["src/lib/orders.ts", "docs/plans/order-emails.md"],
      fresh: ["src/emails/shipped.tsx"],
    },
  ],
  [
    9,
    {
      files: [
        "src/app/orders/[id]/page.tsx",
        "src/components/OrderTimeline.tsx",
        "src/lib/orders.ts",
      ],
      fresh: ["src/components/TrackingMap.tsx"],
    },
  ],
  [
    10,
    {
      files: ["api/server.ts", "api/orders/route.ts", "api/openapi.yaml"],
      fresh: ["api/orders/route.test.ts"],
    },
  ],
]

const entries: readonly string[] = [
  ".env.local",
  ".github/workflows/ci.yml",
  ".gitignore",
  "README.md",
  "api/openapi.yaml",
  "api/orders/route.ts",
  "api/search/index.ts",
  "api/search/tokenize.ts",
  "api/server.ts",
  "api/webhooks/stripe.ts",
  "docs/plans/order-emails.md",
  "e2e/checkout.spec.ts",
  "next.config.ts",
  "node_modules/",
  "package.json",
  "playwright.config.ts",
  "pnpm-lock.yaml",
  "public/favicon.svg",
  "public/logo.svg",
  "src/app/cart/page.tsx",
  "src/app/layout.tsx",
  "src/app/orders/[id]/page.tsx",
  "src/app/page.tsx",
  "src/app/products/[slug]/page.tsx",
  "src/cart/store.ts",
  "src/cart/useCart.ts",
  "src/components/CartDrawer.tsx",
  "src/components/CartDrawer.test.tsx",
  "src/components/Header.tsx",
  "src/components/OrderTimeline.tsx",
  "src/components/Price.tsx",
  "src/components/ProductCard.tsx",
  "src/lib/db.ts",
  "src/lib/orders.ts",
  "src/lib/stripe.ts",
  "src/lib/types.ts",
  "tsconfig.json",
]

const minute = 60_000
const file = (kind: TouchedFile["kind"], touched: TouchedFile["touched"]): TouchedFile => ({
  kind,
  touched,
})

// What the agents changed before the page opened: each agent's work so far, a few minutes old.
const history = (now: number): FilesProject["changes"] => ({
  "src/components/CartDrawer.tsx": file("modified", { [demoHandle(1)]: now - 4 * minute }),
  "src/components/Header.tsx": file("modified", { [demoHandle(1)]: now - 5 * minute }),
  "e2e/checkout.spec.ts": file("modified", { [demoHandle(4)]: now - 3 * minute }),
  "playwright.config.ts": file("modified", { [demoHandle(4)]: now - 6 * minute }),
  "api/webhooks/stripe.ts": file("modified", { [demoHandle(5)]: now - 7 * minute }),
  "src/lib/orders.ts": file("modified", { [demoHandle(9)]: now - 2 * minute }),
  "src/components/OrderTimeline.tsx": file("modified", { [demoHandle(9)]: now - 2 * minute }),
  "api/server.ts": file("modified", { [demoHandle(10)]: now - 9 * minute }),
  "docs/plans/order-emails.md": file("modified", { [demoHandle(7)]: now - 8 * minute }),
})

export const launchFilesScene: FilesScene = {
  projectId: project,
  session,
  slots: writers.map(([number]) => ({
    handle: demoHandle(number),
    terminalId: demoTerminalId(session, number),
  })),
  tree: { entries, ignored: ["node_modules/", ".env.local"] },
  pools: Object.fromEntries(writers.map(([number, pool]) => [demoHandle(number), pool])),
  // Nobody is writing as it opens.
  open: (now) => ({ changes: history(now), writing: {} }),
  held: true,
}

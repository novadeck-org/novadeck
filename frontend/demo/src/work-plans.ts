import { planFile as file, type WorkPlan } from "./works"

// The works each demo opens with, by the titles of its own terminals (see `WorkPlan`): a mix
// of unread and read, one that conflicts with main and, where there are terminals enough, two
// that conflict with each other. The storefront's also has a worktree with no owner, one just
// made (it differs from nothing), and one whose owner's agent is mid-turn in it.

// The sample projects of the plain and agents demos, whose terminals share their titles.
export const storefrontPlans: readonly WorkPlan[] = [
  {
    project: "storefront",
    terminal: "Checkout implementation",
    minutesAgo: 52,
    conflicts: ["main", "Tests"],
    files: [
      file("src/checkout/Checkout.tsx", 120, 34, { conflict: true }),
      file("src/checkout/useCart.ts", 42, 8),
      file("src/api/payments.ts", 60, 14),
      file("src/checkout/Checkout.test.tsx", 88, 0, { conflict: true }),
    ],
  },
  {
    project: "storefront",
    terminal: "Tests",
    minutesAgo: 38,
    conflicts: ["Checkout implementation"],
    files: [
      file("src/checkout/Checkout.test.tsx", 31, 12, { conflict: true }),
      file("src/cart/Cart.test.tsx", 54, 6),
    ],
  },
  {
    project: "storefront",
    terminal: "Checkout review",
    minutesAgo: 140,
    working: true,
    files: [file("src/checkout/Checkout.tsx", 6, 2, { read: true })],
  },
  {
    project: "storefront",
    terminal: "Build",
    minutesAgo: 300,
    files: [
      file("vite.config.ts", 9, 3, { read: true }),
      file("package.json", 2, 2, { read: true }),
    ],
  },
  {
    project: "storefront",
    terminal: null,
    branch: "agent/promo-banner",
    minutesAgo: 600,
    files: [file("src/promo/Banner.tsx", 18, 2, { read: true })],
  },
  {
    project: "storefront",
    terminal: "Build",
    branch: "agent/build-cache",
    minutesAgo: 4,
    files: [],
  },
  {
    project: "api-service",
    terminal: "Checkout implementation",
    minutesAgo: 75,
    files: [
      file("src/routes/orders.ts", 64, 11, { unread: 0.4 }),
      file("db/migrations/0042_orders.sql", 28, 0, { read: true }),
    ],
  },
  {
    project: "api-service",
    terminal: "Tests",
    minutesAgo: 20,
    files: [file("test/orders.test.ts", 47, 5, { read: true })],
  },
  {
    project: "docs-site",
    terminal: "Tests",
    minutesAgo: 90,
    files: [file("docs/guides/getting-started.md", 22, 9)],
  },
  {
    project: "design-system",
    terminal: "Checkout implementation",
    minutesAgo: 210,
    files: [
      file("tokens/color.json", 36, 18),
      file("src/Button/Button.tsx", 12, 4),
      file("src/Button/Button.stories.tsx", 20, 0, { read: true }),
    ],
  },
]

// The showcase: the studio's site, and the website beside it.
export const showcasePlans: readonly WorkPlan[] = [
  {
    project: "studio",
    terminal: "Build Studio",
    minutesAgo: 64,
    conflicts: ["main", "Refactor auth"],
    files: [
      file("src/components/Header.tsx", 112, 41, { conflict: true }),
      file("scripts/build.ts", 140, 30),
      file("scripts/steps/export.ts", 98, 12),
      file("scripts/steps/images.ts", 64, 20),
      file("src/styles/site.css", 50, 14),
      file("scripts/steps/feed.ts", 40, 10),
      file("scripts/studio.snap.test.ts", 20, 10, { read: true }),
    ],
  },
  {
    project: "studio",
    terminal: "Refactor auth",
    minutesAgo: 41,
    conflicts: ["Build Studio"],
    files: [
      file("src/components/Header.tsx", 5, 12, { conflict: true }),
      file("src/auth/session.ts", 38, 0),
      file("src/auth/cookies.ts", 1, 1),
      file("src/auth/session.test.ts", 54, 0, { read: true }),
    ],
  },
  {
    project: "studio",
    terminal: "Dev server",
    minutesAgo: 190,
    files: [file("vite.config.ts", 7, 2, { read: true })],
  },
  {
    project: "website",
    terminal: "Tests",
    minutesAgo: 120,
    files: [file("src/pages/pricing.test.ts", 33, 4, { read: true })],
  },
]

export const chirpPlans: readonly WorkPlan[] = [
  {
    project: "night-shift",
    terminal: "Ledger migration",
    minutesAgo: 95,
    conflicts: ["main", "Auth refactor"],
    files: [
      file("db/migrations/0108_ledger_entries.sql", 76, 0),
      file("src/ledger/entries.ts", 130, 41, { conflict: true }),
      file("src/ledger/entries.test.ts", 88, 12),
    ],
  },
  {
    project: "night-shift",
    terminal: "Auth refactor",
    minutesAgo: 70,
    conflicts: ["Ledger migration"],
    files: [
      file("src/ledger/entries.ts", 4, 9, { conflict: true }),
      file("src/auth/session.ts", 52, 31),
    ],
  },
  {
    project: "night-shift",
    terminal: "Price feed",
    minutesAgo: 30,
    files: [file("src/feed/prices.ts", 44, 6, { unread: 0.5 }), file("src/feed/retry.ts", 18, 0)],
  },
  {
    project: "night-shift",
    terminal: "Flaky tests",
    minutesAgo: 240,
    files: [file("test/helpers/clock.ts", 15, 7, { read: true })],
  },
  {
    project: "ice-breaker",
    terminal: "Scanner",
    minutesAgo: 55,
    files: [file("src/scan/ports.rs", 72, 18), file("src/scan/banner.rs", 31, 2, { read: true })],
  },
]

export const babciaPlans: readonly WorkPlan[] = [
  {
    project: "bar-mleczny",
    terminal: "Menu page",
    minutesAgo: 80,
    conflicts: ["main", "Menu translations"],
    files: [
      file("src/pages/Menu.tsx", 96, 28, { conflict: true }),
      file("src/components/Dish.tsx", 44, 10),
      file("src/styles/menu.css", 30, 6),
    ],
  },
  {
    project: "bar-mleczny",
    terminal: "Menu translations",
    minutesAgo: 45,
    conflicts: ["Menu page"],
    files: [
      file("src/pages/Menu.tsx", 12, 12, { conflict: true }),
      file("src/i18n/pl.json", 64, 0),
      file("src/i18n/en.json", 64, 0, { read: true }),
    ],
  },
  {
    project: "bar-mleczny",
    terminal: "Opening hours",
    minutesAgo: 160,
    files: [file("src/components/Hours.tsx", 21, 8, { read: true })],
  },
  {
    project: "bar-mleczny",
    terminal: "Prices table",
    minutesAgo: 25,
    files: [file("src/components/PriceTable.tsx", 58, 14)],
  },
  {
    project: "setlist",
    terminal: "Stage plot",
    minutesAgo: 110,
    files: [file("src/plot/Stage.tsx", 40, 9, { read: true })],
  },
]

export const launchPlans: readonly WorkPlan[] = [
  {
    project: "northwind",
    terminal: "Cart drawer",
    minutesAgo: 68,
    conflicts: ["main", "Order status page"],
    files: [
      file("src/cart/CartDrawer.tsx", 128, 46, { conflict: true }),
      file("src/cart/useCart.ts", 36, 9),
      file("src/cart/CartDrawer.test.tsx", 72, 0),
    ],
  },
  {
    project: "northwind",
    terminal: "Order status page",
    minutesAgo: 33,
    conflicts: ["Cart drawer"],
    files: [
      file("src/cart/useCart.ts", 6, 3, { conflict: true }),
      file("src/orders/StatusPage.tsx", 85, 0),
    ],
  },
  {
    project: "northwind",
    terminal: "Stripe webhooks",
    minutesAgo: 150,
    files: [
      file("api/webhooks/stripe.ts", 64, 12, { read: true }),
      file("api/webhooks/stripe.test.ts", 48, 0, { read: true }),
    ],
  },
  {
    project: "northwind",
    terminal: "Search index",
    minutesAgo: 22,
    files: [file("api/search/index.ts", 39, 11, { unread: 0.6 })],
  },
  {
    project: "northwind-docs",
    terminal: "API reference",
    minutesAgo: 100,
    files: [file("docs/api/orders.md", 54, 13)],
  },
]

// The website's visitor demo: a tidy desk, so few, and the agent at rest has its work read.
export const visitorPlans: readonly WorkPlan[] = [
  {
    project: "storefront",
    terminal: "Checkout implementation",
    minutesAgo: 47,
    conflicts: ["main", "Tests"],
    files: [
      file("src/checkout/Checkout.tsx", 96, 22, { conflict: true }),
      file("src/checkout/useCart.ts", 38, 7),
      file("src/api/payments.ts", 52, 9),
    ],
  },
  {
    project: "storefront",
    terminal: "Tests",
    minutesAgo: 26,
    conflicts: ["Checkout implementation"],
    files: [
      file("src/checkout/Checkout.tsx", 4, 4, { conflict: true }),
      file("src/checkout/Checkout.test.tsx", 64, 8),
    ],
  },
  {
    project: "api-service",
    terminal: "Rate limiting",
    minutesAgo: 180,
    files: [
      file("src/middleware/rateLimit.ts", 58, 6, { read: true }),
      file("src/middleware/rateLimit.test.ts", 41, 0, { read: true }),
    ],
  },
]

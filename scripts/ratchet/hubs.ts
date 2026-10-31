import type { Hub } from "./ratchet"

// The files whose classes the ratchet holds to budgets that only go down.
export const hubs: readonly Hub[] = [
  {
    path: "backend/runner/src/terminals/manager.ts",
    className: "Terminals",
    budgetsPath: "scripts/ratchet/manager.json",
    home: "a sibling module under backend/runner/src/terminals/ (as closes.ts, opens.ts and titles.ts are)",
  },
  {
    path: "backend/runner/src/messaging/messaging.ts",
    className: "Messaging",
    budgetsPath: "scripts/ratchet/messaging.json",
    home: "a sibling module under backend/runner/src/messaging/ (as delivery.ts, leases.ts and loops.ts are)",
  },
]

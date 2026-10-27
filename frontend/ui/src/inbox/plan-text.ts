import type { InboxRow } from "@novadeck/core/inbox"

// The plan an agent asks the person to approve, as the Markdown it wrote, for the plan
// sheet's box: Claude Code's plan file, Codex's proposed plan, Antigravity's implementation
// plan.

// The plan of a plan-approval item: undefined while it loads, null where there is none.
export const usePlanText = (_item: InboxRow): string | null | undefined => undefined

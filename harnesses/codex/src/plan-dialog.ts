import { refuse } from "@novadeck/harness-core/dialogs"

import { type Choice, choose, optionsAt, type Parsed, type Wording } from "./dialog-screen.js"

export const planTitle = "Implement this plan?"
const planWordings: readonly Wording[] = [
  { label: /^Yes, implement this plan$/ },
  { label: /^Yes, clear context and implement$/ },
  { label: /^No, stay in Plan mode$/, prompt: true },
]

/** Codex's prompt after a plan, only as the popup at the bottom of the screen. */
export const plan = (lines: readonly string[]): Parsed | undefined => {
  const title = lines.findLastIndex((line) => line.trim() === planTitle)
  if (title < 0) return refuse("plan.plan.1")
  const { rows, next } = optionsAt(lines, title + 1)
  if (rows.length !== planWordings.length) return refuse("plan.plan.2")
  // Only the popup at the bottom: its footer is the screen's last row.
  if (next !== lines.length - 1 || !/^\s*\S+ select · \S+ back\s*$/.test(lines[next]!)) {
    return refuse("plan.plan.3")
  }
  const picks: Choice[] = []
  for (const [i, row] of rows.entries()) {
    const wording = planWordings[i]!
    const label = row.head.split("  ")[0]!.trim()
    if (!wording.label.test(label)) return refuse("plan.plan.4")
    picks.push({
      id: String(row.n),
      label,
      key: String(row.n),
      text: wording.prompt ? "prompt" : null,
    })
  }
  return choose(planTitle, picks, null)
}

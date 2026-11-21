import type { PreviewHunk } from "@novadeck/core/works"

// The tour's repo as the story's fixers change it (the runner's `prepare` writes the real one): its
// one file, `split.js`, with both bugs, and what each fixer's edit does to it. The merged
// preview shows both.

export const splitFile = "split.js"

// The tour repo's files, as its Files panel lists them.
export const tourEntries: readonly string[] = ["AGENTS.md", "CLAUDE.md", "README.md", "split.js"]

// Main's copy.
export const splitMain =
  [
    "// Splits a restaurant bill: its total, how many people share it, and the tip in percent",
    "// (15 means 15%).",
    "export const share = (total, people, tip) => (total + total * tip) / people",
    "",
    "// An amount as the receipt shows it, such as $12.50.",
    'export const money = (amount) => "$" + amount.toFixed(1)',
  ].join("\n") + "\n"

export const tipBranch = "fix-tip"
export const moneyBranch = "fix-money"

const hunk = (at: number, removed: number, lines: string[]): PreviewHunk => ({
  at,
  removed,
  lines,
  applies: true,
})

// Bug 1: the tip is in percent, so it is divided by 100.
export const tipHunk = hunk(3, 1, [
  "export const share = (total, people, tip) => (total + (total * tip) / 100) / people",
])

// The answers to the money ask, as its options A and B: two decimals always, or the .00 left off
// whole amounts.
export const moneyAnswers = [
  {
    label: "$12.00",
    summary: "Always two decimals.",
    lines: ['export const money = (amount) => "$" + amount.toFixed(2)'],
  },
  {
    label: "$12",
    summary: "Drop .00 for whole amounts.",
    lines: [
      "export const money = (amount) =>",
      '  "$" + (Number.isInteger(amount) ? amount : amount.toFixed(2))',
    ],
  },
] as const

// Bug 2 as the answer at `option` has it fixed.
export const moneyHunk = (option: number): PreviewHunk =>
  hunk(6, 1, [...(moneyAnswers[option] ?? moneyAnswers[0]).lines])

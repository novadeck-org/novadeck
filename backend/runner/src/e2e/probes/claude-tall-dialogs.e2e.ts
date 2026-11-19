import { text } from "../model/script.js"
import { own, result } from "../scenarios.js"
import { surface, tweak } from "./claude-support.js"

// PROBE, not a test of Novadeck: how Claude Code draws its plan and question dialogs when they
// are taller than the screen (2.1.328 draws ` ↑ N more lines` under a permission dialog's
// options then). The screens go to PROBE_OUT, merged into fixtures/tall-dialogs.probe.json.
//
// Run: PROBE_OUT=<folder> NOVADECK_E2E_PROBES=1 pnpm --filter @novadeck/runner exec vitest run \
//   --config vitest.e2e.config.ts src/e2e/probes/claude-tall-dialogs.e2e.ts

const steps = Array.from({ length: 120 }, (_, n) => `${n + 1}. Step ${n + 1} of a long plan`)
const plan = `# Plan\n\n${steps.join("\n")}\n`

const planning = (run: Parameters<typeof tweak>[0]) =>
  tweak(run, (s) => {
    s.permissions.defaultMode = "plan"
  })

// A plan given in the call itself ("Exit plan mode?" before 2.1.32x).
surface({
  name: "tall-plan-input",
  reply: { calls: [{ name: "ExitPlanMode", input: { plan } }] },
  shows: /Exit plan mode\?|Ready to code\?/,
  setup: planning,
  sizes: [
    [60, 12],
    [120, 34],
    [120, 30],
    [120, 26],
    [120, 22],
    [120, 18],
  ],
})

// A plan written to its file, then ExitPlanMode with none: "Ready to code?".
surface({
  name: "tall-plan-file",
  reply: {},
  custom: (seen) => [
    own((call) => {
      const last = call.turns.at(-1)
      const plans = text(call).match(/\/[^\s"'`]*\/plans\/[\w.-]+\.md/)
      if (call.turns.some((x) => x.role === "assistant")) {
        if (last?.role === "tool" && /File created|updated/.test(last.text))
          return { calls: [{ name: "ExitPlanMode", input: {} }] }
        const r = result(call)
        if (r !== undefined) {
          seen.result = r
          return { text: "Done." }
        }
        return undefined
      }
      if (plans)
        return { calls: [{ name: "Write", input: { file_path: plans[0], content: plan } }] }
      return { text: "no plan path found" }
    }),
  ],
  shows: /Ready to code\?|Would you like to proceed|Here is Claude's plan/,
  setup: planning,
  sizes: [
    [60, 12],
    [120, 34],
    [120, 30],
    [120, 26],
    [120, 22],
    [120, 18],
  ],
})

const preview = Array.from({ length: 70 }, (_, n) => `line ${n + 1} of a preview`).join("\n")
const tall = {
  question: "Which database should we use?",
  header: "Database",
  multiSelect: false,
  options: [
    { label: "Postgres", description: "Relational, battle tested, needs a server", preview },
    { label: "SQLite", description: "Embedded, zero setup, single writer", preview },
    { label: "DuckDB", description: "Analytical, columnar", preview },
  ],
}
const long = {
  question: "Which features should be enabled?",
  header: "Features",
  multiSelect: true,
  options: ["Auth", "Billing", "Search", "Export"].map((label) => ({
    label,
    description: `${label}: ${"a long description of what it does and why it matters. ".repeat(6)}`,
  })),
}

// A previewed question with long previews, and a multi-select with long descriptions.
surface({
  name: "tall-ask-preview",
  reply: { calls: [{ name: "AskUserQuestion", input: { questions: [tall] } }] },
  shows: /Which database should we use\?/,
  sizes: [
    [60, 12],
    [120, 34],
    [120, 30],
    [120, 26],
    [120, 22],
    [120, 18],
  ],
})
surface({
  name: "tall-ask-long",
  reply: { calls: [{ name: "AskUserQuestion", input: { questions: [long] } }] },
  shows: /Which features should be enabled\?/,
  sizes: [
    [60, 12],
    [120, 34],
    [120, 30],
    [120, 26],
    [120, 22],
    [120, 18],
  ],
})

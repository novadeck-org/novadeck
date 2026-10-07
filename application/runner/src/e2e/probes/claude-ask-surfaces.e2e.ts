import { text } from "../model/script.js"
import { own, result } from "../scenarios.js"
import { sleep, surface, tweak } from "./claude-support.js"

const q1 = {
  question: "Which database should we use?",
  header: "Database",
  multiSelect: false,
  options: [
    {
      label: "Postgres",
      description: "Relational, battle tested, needs a server",
    },
    { label: "SQLite", description: "Embedded, zero setup, single writer" },
    { label: "DuckDB", description: "Analytical, columnar" },
  ],
}
const q2 = {
  question: "Which features should be enabled?",
  header: "Features",
  multiSelect: true,
  options: [
    { label: "Auth", description: "Login and sessions" },
    { label: "Billing", description: "Stripe integration" },
    { label: "Search", description: "Full text search" },
  ],
}
const q3 = {
  question: "Which region should it deploy to?",
  header: "Region",
  multiSelect: false,
  options: [
    { label: "eu-west", description: "Ireland" },
    { label: "us-east", description: "Virginia" },
  ],
}
const ask = (...questions: unknown[]) => ({
  calls: [{ name: "AskUserQuestion", input: { questions } }],
})
const Down = "\x1b[B"

surface({
  name: "ask-multi",
  reply: ask(q1, q2, q3),
  shows: /Which database should we use\?/,
  drive: async (t, _p, shot) => {
    t.press("2")
    await shot("after-q1")
    // multiselect: toggle 1 and 3 by digit? by space?
    t.press("1")
    await shot("toggled-1")
    t.press(Down)
    t.press(Down)
    await shot("moved-down-2")
    t.press(" ")
    await shot("space-on-3")
    t.press(Down)
    t.press(Down)
    await shot("on-next-row")
  },
})

surface({
  name: "ask-multi-finish",
  reply: ask(q1, q2, q3),
  shows: /Which database should we use\?/,
  drive: async (t, _p, shot) => {
    t.press("2")
    await shot("after-q1")
    t.press("1")
    await sleep(200)
    t.press("3")
    await shot("toggled-1-3")
    t.press("\x1b[C") // right arrow: next tab?
    await shot("after-right")
    t.press("1")
    await shot("after-q3")
    // expect submit tab now
  },
})

surface({
  name: "ask-other",
  reply: ask(q1),
  shows: /Which database should we use\?/,
  drive: async (t, _p, shot) => {
    t.press("4")
    await shot("pressed-4")
    t.press("MariaDB please")
    await shot("typed")
  },
})

surface({
  name: "ask-preview",
  reply: ask({
    ...q1,
    options: [
      {
        ...q1.options[0],
        preview: "CREATE TABLE a (\n  id int\n);\n-- postgres",
      },
      { ...q1.options[1], preview: "CREATE TABLE a (id integer);\n-- sqlite" },
    ],
  }),
  shows: /Which database should we use\?/,
  drive: async (t, _p, shot) => {
    t.press(Down)
    await shot("down")
    t.press("1")
    await shot("pressed-1")
  },
})

surface({
  name: "ask-long",
  reply: ask({
    question:
      "Which of these four lengthy approaches should I take for the migration of the legacy billing system?",
    header: "Approach",
    multiSelect: false,
    options: [
      "Big bang cutover",
      "Strangler fig pattern",
      "Parallel run with diffing",
      "Dual write then flip",
    ].map((label) => ({
      label,
      description: `${label}: a long explanation of the trade-offs that spans well over a single line on a small terminal so that wrapping and scrolling are exercised properly here`,
    })),
  }),
  shows: /Which of these four/,
  sizes: [
    [60, 20],
    [60, 12],
  ],
  drive: async (t, _p, shot) => {
    t.press("4")
    await shot("pressed-4")
  },
})

surface({
  name: "plan",
  reply: {
    calls: [
      {
        name: "ExitPlanMode",
        input: { plan: "# Plan\n\n1. Do the thing\n2. Test it\n" },
      },
    ],
  },
  shows: /Exit plan mode\?/,
  setup: (run) =>
    tweak(run, (s) => {
      s.permissions.defaultMode = "plan"
    }),
  drive: async (t, _p, shot) => {
    t.press("4")
    await shot("pressed-4")
  },
})

surface({
  name: "mcp",
  reply: {
    calls: [{ name: "mcp__plugin_novadeck_novadeck__agents", input: {} }],
  },
  shows: /Tool use|Do you want to proceed\?/,
  setup: (run) =>
    tweak(run, (s) => {
      s.permissions.allow = ["Bash(claude -p:*)"]
    }),
  drive: async (t, _p, _shot) => {
    t.press("3")
  },
})

surface({
  name: "plan-file",
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
        return {
          calls: [
            {
              name: "Write",
              input: {
                file_path: plans[0],
                content: "# Plan\n\n1. Do the thing\n2. Test it\n",
              },
            },
          ],
        }
      return { text: "no plan path found" }
    }),
  ],
  shows: /Ready to code\?|Would you like to proceed|Here is Claude's plan/,
  setup: (run) =>
    tweak(run, (s) => {
      s.permissions.defaultMode = "plan"
    }),
  drive: async (t, _p, shot) => {
    t.press("2")
    await shot("pressed-2")
  },
})

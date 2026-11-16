import { text } from "../model/script.js"
import { own, result } from "../scenarios.js"
import { capture, surface, tweak } from "./claude-support.js"
import { sleep } from "./support.js"

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
const Up = "\x1b[A"

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

// Reported 2026-11-13 (Claude Code 2.1.323): one question whose first option alone has a
// preview, with a long question and a label that wraps beside the preview's box in a narrow
// pane; the chat showed "Claude's own dialog" for it.
surface({
  name: "ask-preview-mixed",
  reply: ask({
    question:
      'A reviewer left four comments on the pull request. I\'ve rebased it onto main and fixed all four (checks and the end-to-end tests pass locally). Because of the rebase the push has to be a force-push (--force-with-lease). OK to commit, force-push, fix the repeated "Short copy" sentence in its description, and post the four replies below?',
    header: "Review",
    multiSelect: false,
    options: [
      {
        label: "Push and reply (Recommended)",
        description:
          "Commit as shown, force-push with lease, fix the description, post the replies",
        preview:
          "Commit:\nfix(home): address the review of the card stack\n\nDerive the stacking margins from a card count on the list, point\nthe sticky top at the header, check the overlap in the short\ndesktop test, and set reduced motion in the test body.\n\nReply on the sticky top:\nAdded a comment on `top` pointing at the header.",
      },
      {
        label: "Push, no replies",
        description: "Commit, force-push and fix the description; I'll reply to the threads myself",
      },
      { label: "Not yet", description: "Leave everything local so I can review first" },
    ],
  }),
  shows: /☐ Review/,
  sizes: [
    [80, 40],
    [60, 40],
    [52, 40],
    [52, 30],
  ],
  drive: async (t, _p, shot) => {
    t.press(Down)
    await shot("down")
    t.press(Down)
    await shot("down-2")
    t.resize(52, 40)
    await shot("down-2-52x40", 900)
    t.press(Up)
    t.press(Up)
    await shot("top-52x40")
  },
})

// Reported 2026-11-16 (Claude Code 2.1.325): two questions, the first with a preview on every
// option, in a narrow chat; the chat showed "Claude's own dialog" for it.
const previewTabs = [
  {
    question:
      "Which look for a harness that isn't installed (e.g. Antigravity) on the welcome card? Screenshots A, B and C are open beside the terminal.",
    header: "Install card",
    multiSelect: false,
    options: [
      {
        label: "A: command row (Recommended)",
        description:
          "'Not installed' badge by the name, Install button (download icon) top right, the whole command on its own wrapped line in a code box. Keeps #945's 'nothing hidden' rule; the card is taller.",
        preview:
          "┌──────────────────────────────────────┐\n│ [A] Antigravity (Not installed) [⬇ Install] │\n│     Install runs its official installer:    │\n│     ┌────────────────────────────────┐      │\n│     │ $ curl -fsSL https://antigrav… │      │\n│     │   /cli/install.sh | bash       │      │\n│     └────────────────────────────────┘      │\n└──────────────────────────────────────┘",
      },
      {
        label: "B: empty seat",
        description:
          "Dashed card titled 'Add Antigravity', a cyan Install button, the command behind 'Show command'. Compact and inviting, but the cyan button competes with 'Let’s build something' and the command is one click away.",
        preview:
          "┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐\n╎ [╌A╌] Add Antigravity      [⬇ Install] ╎\n╎       Not installed yet. Show command   ╎\n└╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘",
      },
      {
        label: "C: quiet line",
        description:
          "No card: one muted line under the agents, 'Antigravity isn’t installed. Install it', with the command as a tooltip. Lightest, but easy to miss, and the command shows only on hover.",
        preview: "[Claude Code card]\n[Codex card]\n A  Antigravity isn’t installed. Install it",
      },
    ],
  },
  {
    question:
      "Rename 'Chat view'? In Preferences, 'View modes' already means Focus/Grid/Canvas, so 'Chat view' can read like a fourth layout. Only labels and docs change; the saved setting keeps its key.",
    header: "Name",
    multiSelect: false,
    options: [
      {
        label: "Agent chat (Recommended)",
        description:
          "Says what it is and where it applies; no clash with views. E.g. 'Agent chat: read and reply to agents in a chat instead of their terminal.'",
      },
      {
        label: "Keep 'Chat view'",
        description: "No change.",
      },
      {
        label: "Chat",
        description: "Shortest; good for a header toggle, vaguer as a setting.",
      },
      {
        label: "Reader",
        description:
          "Like a browser's reader mode: the same session, made readable. Undersells that you can reply.",
      },
    ],
  },
]

surface({
  name: "ask-preview-tabs",
  reply: ask(...previewTabs),
  shows: /Install card/,
  sizes: [
    [80, 40],
    [60, 40],
    [56, 40],
    [52, 40],
  ],
  drive: async (t, _p, shot) => {
    await t.confirm(/❯ 2\. B: empty seat/, async () => {
      t.press(Down)
      await shot("down")
    })
    await shot("q2")
    t.press("2")
    await shot("review")
    t.press("1")
    await shot("submitted", 1500)
  },
})

// The runner reads it at a narrow chat's width and answers it as the chat would.
surface({
  name: "ask-preview-tabs-native",
  reply: ask(...previewTabs),
  shows: /Install card/,
  sizes: [],
  drive: async (t, _p, shot) => {
    t.resize(56, 40)
    await shot("native", 900)
    const request = (await t.detail()).requests.find((each) => each.kind === "question")
    const dialog = request?.dialog
    if (!request || dialog?.type !== "questions") throw new Error("No native question at 56×40")
    await t.answer(request.ref, {
      type: "questions",
      dialog: dialog.id,
      answers: [
        { question: "q1", options: ["2"] },
        { question: "q2", options: ["2"] },
      ],
    })
    await shot("answered", 1500)
    const remaining = (await t.detail()).requests.length
    if (remaining !== 0) throw new Error("The question remained pending after its native answer")
    capture("ask-preview-tabs-native-answer", { dialog, remaining })
  },
})

// The same two questions the other way round: the previews on the last.
surface({
  name: "ask-preview-tabs-last",
  reply: ask(previewTabs[1], previewTabs[0]),
  shows: /Rename 'Chat view'/,
  sizes: [[56, 40]],
  drive: async (t, _p, shot) => {
    t.press("1")
    await shot("q2")
    await t.confirm(/❯ 2\. B: empty seat/, async () => {
      t.press(Down)
      await shot("q2-down")
    })
    await shot("review")
    t.press("1")
    await shot("submitted", 1500)
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

// The question reported in Grid: at 60×20 Claude's alternate screen discards its
// header; at the chat's taller hidden size the full dialog reads and takes an answer.
surface({
  name: "ask-grid-wrapped",
  reply: ask({
    question:
      "Canvas windows are a fixed 864×576. If Canvas used Grid's split pane, the terminal would shrink to about 45 columns while the pane is open. Which version should I build?",
    header: "Canvas pane",
    multiSelect: false,
    options: [
      {
        label: "Straight swap (Recommended)",
        description:
          "Canvas uses Grid's split exactly: divider, cover mode, and the hanging sheet code is deleted. The terminal gets narrower while the pane is open.",
      },
      {
        label: "Split + widen window",
        description:
          "The window grows to the right when the pane opens, so the terminal keeps its width. Needs a size per window across all Canvas geometry; bigger and riskier.",
      },
      { label: "Just the opinion", description: "Don't build anything yet." },
    ],
  }),
  shows: /Which version should I build\?/,
  sizes: [
    [80, 24],
    [80, 30],
    [60, 20],
    [60, 40],
  ],
  drive: async (t, _p, shot) => {
    t.resize(60, 40)
    await shot("native", 900)
    const request = (await t.detail()).requests.find((each) => each.kind === "question")
    const dialog = request?.dialog
    if (!request || dialog?.type !== "questions") throw new Error("No native question at 60×40")
    await t.answer(request.ref, {
      type: "questions",
      dialog: dialog.id,
      answers: [{ question: "q1", options: ["2"] }],
    })
    await shot("answered", 900)
    const remaining = (await t.detail()).requests.length
    if (remaining !== 0) throw new Error("The question remained pending after its native answer")
    capture("ask-grid-native-answer", { dialog, remaining })
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

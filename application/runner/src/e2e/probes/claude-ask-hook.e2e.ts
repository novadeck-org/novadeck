// (H) route probes: what a PermissionRequest hook can decide, and what the TUI does while
// the hook waits.
import { text, type Rule } from "../model/script.js"
import { own, result } from "../scenarios.js"
import { sleep, surface, tweak, type Out } from "./claude-support.js"

const decide = (decision: Record<string, unknown>): Out => ({
  stdout: {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
  },
})
const allow = (extra: Record<string, unknown> = {}) => decide({ behavior: "allow", ...extra })
const deny = (message: string, interrupt?: boolean) =>
  decide({
    behavior: "deny",
    message,
    ...(interrupt === undefined ? {} : { interrupt }),
  })

const bash = (command: string) => ({
  name: "Bash",
  input: { command, description: "Run it" },
})
const q1 = {
  question: "Which database should we use?",
  header: "Database",
  multiSelect: false,
  options: [
    { label: "Postgres", description: "Relational" },
    { label: "SQLite", description: "Embedded" },
    { label: "DuckDB", description: "Columnar" },
  ],
}
const q2 = {
  question: "Which features should be enabled?",
  header: "Features",
  multiSelect: true,
  options: [
    { label: "Auth", description: "Login" },
    { label: "Billing", description: "Stripe" },
    { label: "Search", description: "FTS" },
  ],
}
const askCall = { name: "AskUserQuestion", input: { questions: [q1, q2] } }

// Two Bash calls in one turn, one after the other, to see whether a rule from the first sticks.
const twice = (seen: { result?: string }): Rule[] => [
  own((call) => {
    const last = call.turns.at(-1)
    if (last?.role === "tool") {
      seen.result = `${seen.result ?? ""}|${last.text}`
      const calls = call.turns.filter((x) => x.role === "assistant").length
      return calls < 2 ? { calls: [bash("touch second.txt")] } : { text: "Done." }
    }
    return { calls: [bash("touch first.txt")] }
  }),
]

const planRules = (seen: { result?: string }): Rule[] => [
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
]
const planMode = (run: Parameters<typeof tweak>[0]) =>
  tweak(run, (s) => {
    s.permissions.defaultMode = "plan"
  })

const now = (out: Out) => (_run: unknown, probe: import("./claude-support.js").Probe) =>
  probe.config("PermissionRequest", { now: out })

// ---- decisions
surface({
  name: "h-bash-allow",
  reply: { calls: [bash("touch hooked.txt")] },
  hookStart: "PermissionRequest",
  setup: now(allow()),
})
surface({
  name: "h-bash-deny",
  reply: { calls: [bash("touch hooked.txt")] },
  hookStart: "PermissionRequest",
  setup: now(deny("Use ls instead, please.")),
})
surface({
  name: "h-bash-deny-interrupt",
  reply: { calls: [bash("touch hooked.txt")] },
  hookStart: "PermissionRequest",
  setup: now(deny("Stop right there.", true)),
})
surface({
  name: "h-bash-updatedInput",
  reply: { calls: [bash("touch original.txt")] },
  hookStart: "PermissionRequest",
  setup: now(
    allow({
      updatedInput: { command: "touch changed.txt", description: "Changed" },
    }),
  ),
})
surface({
  name: "h-bash-updatedPermissions",
  reply: {},
  custom: twice,
  hookStart: "PermissionRequest",
  setup: now(
    allow({
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "touch:*" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    }),
  ),
  drive: async (_t, _probe) => {
    await sleep(2500)
  },
})
surface({
  name: "h-bash-allow-then-ask-again",
  reply: {},
  custom: twice,
  hookStart: "PermissionRequest",
  setup: now(allow()),
  drive: async () => {
    await sleep(2500)
  },
})

// ---- AskUserQuestion
surface({
  name: "h-ask-allow-answers",
  reply: { calls: [askCall] },
  hookStart: "PermissionRequest",
  setup: now(
    allow({
      updatedInput: {
        questions: [q1, q2],
        answers: { [q1.question]: "SQLite", [q2.question]: "Auth, Search" },
      },
    }),
  ),
})
surface({
  name: "h-ask-allow-plain",
  reply: { calls: [askCall] },
  hookStart: "PermissionRequest",
  setup: now(allow()),
})
surface({
  name: "h-ask-deny",
  reply: { calls: [askCall] },
  hookStart: "PermissionRequest",
  setup: now(deny("The person said: skip questions.")),
})
surface({
  name: "h-ask-other-answer",
  reply: { calls: [{ name: "AskUserQuestion", input: { questions: [q1] } }] },
  hookStart: "PermissionRequest",
  setup: now(
    allow({
      updatedInput: {
        questions: [q1],
        answers: { [q1.question]: "MariaDB, my own words" },
      },
    }),
  ),
})

// ---- plan
surface({
  name: "h-plan-allow",
  reply: {},
  custom: planRules,
  hookStart: "PermissionRequest",
  setup: (run, probe) => {
    planMode(run)
    now(allow())(run, probe)
  },
})
surface({
  name: "h-plan-deny",
  reply: {},
  custom: planRules,
  hookStart: "PermissionRequest",
  setup: (run, probe) => {
    planMode(run)
    now(deny("Add a rollback step."))(run, probe)
  },
})
surface({
  name: "h-plan-setMode",
  reply: {},
  custom: planRules,
  hookStart: "PermissionRequest",
  setup: (run, probe) => {
    planMode(run)
    now(
      allow({
        updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      }),
    )(run, probe)
  },
  drive: async (t, _p, shot) => {
    await shot("after")
  },
})

// ---- pending hook UX
const waits =
  (wait: number, after: Out = {}) =>
  (_run: unknown, probe: import("./claude-support.js").Probe) =>
    probe.config("PermissionRequest", { wait, after })
surface({
  name: "h-wait-nodecision",
  reply: { calls: [bash("touch waited.txt")] },
  hookStart: "PermissionRequest",
  setup: waits(8000),
  drive: async (t, probe, shot) => {
    await shot("during-wait-1s", 1000)
    await shot("during-wait-5s", 4000)
    await probe.waitLog("PermissionRequest", "end", 20_000)
    await shot("after-hook-ended", 1500)
    t.press("3")
  },
})
surface({
  name: "h-wait-tui-first",
  reply: { calls: [bash("touch waited.txt")] },
  hookStart: "PermissionRequest",
  setup: waits(60_000),
  drive: async (t, probe, shot) => {
    await shot("during-wait", 1000)
    t.press("1")
    await shot("after-key-1", 2500)
    // The hook is still waiting; answer it late with deny.
    probe.reply("PermissionRequest", deny("too late"))
    await shot("after-late-reply", 3000)
  },
})
surface({
  name: "h-wait-reply-then-tui",
  reply: { calls: [bash("touch waited.txt")] },
  hookStart: "PermissionRequest",
  setup: waits(60_000),
  drive: async (t, probe, shot) => {
    await shot("during-wait", 1000)
    probe.reply("PermissionRequest", allow())
    await shot("after-reply", 2500)
  },
})
surface({
  name: "h-wait-timeout",
  reply: { calls: [bash("touch waited.txt")] },
  hookStart: "PermissionRequest",
  setup: (run, probe) => {
    probe.config("PermissionRequest", { wait: 60_000 })
  },
  hookTimeout: 4,
  drive: async (t, probe, shot) => {
    await shot("during-wait", 1500)
    await shot("after-timeout-window", 6000)
    t.press("3")
  },
})
surface({
  name: "h-ask-wait-tui-first",
  reply: { calls: [askCall] },
  hookStart: "PermissionRequest",
  setup: waits(60_000),
  drive: async (t, probe, shot) => {
    await shot("during-wait", 1000)
    t.press("2")
    await shot("after-key-2", 2000)
    probe.reply(
      "PermissionRequest",
      allow({
        updatedInput: {
          questions: [q1, q2],
          answers: { [q1.question]: "Postgres", [q2.question]: "Billing" },
        },
      }),
    )
    await shot("after-late-reply", 3000)
  },
})
surface({
  name: "h-ask-wait-nodecision",
  reply: { calls: [askCall] },
  hookStart: "PermissionRequest",
  setup: waits(5000),
  drive: async (t, probe, shot) => {
    await shot("during-wait", 1000)
    await probe.waitLog("PermissionRequest", "end", 20_000)
    await shot("after-hook-ended", 1500)
  },
})

// ---- requiresUserInteraction tools: other ways past their dialog
const pre = (extra: Record<string, unknown>): Out => ({
  stdout: {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "chat",
      ...extra,
    },
  },
})
const preCfg = (out: Out) => (_run: unknown, probe: import("./claude-support.js").Probe) =>
  probe.config("PreToolUse", { now: out })
surface({
  name: "h-plan-allow-updatedInput",
  reply: {},
  custom: planRules,
  hookStart: "PermissionRequest",
  setup: (run, probe) => {
    planMode(run)
    now(allow({ updatedInput: {} }))(run, probe)
  },
})
surface({
  name: "h-plan-pre-allow",
  reply: {},
  custom: planRules,
  hookStart: "PermissionRequest",
  setup: (run, probe) => {
    planMode(run)
    preCfg(pre({}))(run, probe)
  },
})
surface({
  name: "h-plan-pre-allow-updatedInput",
  reply: {},
  custom: planRules,
  hookStart: "PreToolUse",
  settle: 3000,
  setup: (run, probe) => {
    planMode(run)
    preCfg(pre({ updatedInput: {} }))(run, probe)
  },
})
surface({
  name: "h-ask-pre-allow-answers",
  reply: { calls: [askCall] },
  hookStart: "PreToolUse",
  setup: preCfg(
    pre({
      updatedInput: {
        questions: [q1, q2],
        answers: { [q1.question]: "Postgres", [q2.question]: "Billing" },
      },
    }),
  ),
})
surface({
  name: "h-ask-allow-partial-answers",
  reply: { calls: [askCall] },
  hookStart: "PermissionRequest",
  setup: now(
    allow({
      updatedInput: {
        questions: [q1, q2],
        answers: { [q1.question]: "Postgres" },
      },
    }),
  ),
})
surface({
  name: "h-ask-allow-bogus-answer-multi",
  reply: { calls: [askCall] },
  hookStart: "PermissionRequest",
  setup: now(
    allow({
      updatedInput: {
        questions: [q1, q2],
        answers: {
          [q1.question]: "Postgres",
          [q2.question]: ["Auth", "Billing"],
        },
      },
    }),
  ),
})
surface({
  name: "h-plan-allow-setMode",
  reply: {},
  custom: planRules,
  hookStart: "PermissionRequest",
  setup: (run, probe) => {
    planMode(run)
    now(
      allow({
        updatedInput: {},
        updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      }),
    )(run, probe)
  },
  drive: async (_t, _p, shot) => {
    await shot("after", 1500)
  },
})

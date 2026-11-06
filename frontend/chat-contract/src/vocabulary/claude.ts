import type { Written } from "../fixtures"

// Synthetic Claude Code records (see README.md): the JSONL lines Claude Code writes.

const stamp = "2026-10-01T12:00:00.000Z"

export const said = (text: string): object => ({
  type: "user",
  timestamp: stamp,
  message: { role: "user", content: text },
})

const replied = (text: string): object => ({
  type: "assistant",
  timestamp: stamp,
  message: { role: "assistant", content: [{ type: "text", text }] },
})

// A call is [tool, input, result]; a result left out is a call still running, and one that
// is an object (`orphan`) is a result whose call is not in the conversation.
type Call = readonly [tool: string, input: object, result?: string | object[]]

export const calls = (scenario: string, list: readonly Call[]): object[] =>
  list.flatMap(([name, input, result], index) => {
    const id = `toolu_${scenario}_${index}`
    return [
      {
        type: "assistant",
        timestamp: stamp,
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
      },
      ...(result === undefined
        ? []
        : [
            {
              type: "user",
              timestamp: stamp,
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: id, content: result }],
              },
            },
          ]),
    ]
  })

const orphan = (text: string): object => ({
  type: "user",
  timestamp: stamp,
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_gone", content: text }],
  },
})

const novadeck = "mcp__plugin_novadeck_novadeck__"

export const claudeVocabulary: readonly Written[] = [
  {
    name: "files-and-shell",
    records: [
      said("Look at the project."),
      ...calls("files", [
        ["Bash", { command: "npm test" }, "ok\n2 passed"],
        ["Read", { file_path: "/home/user/project/src/index.ts" }, "export {}"],
        ["Write", { file_path: "/home/user/project/notes.md", content: "# Notes\nfirst" }, "Done"],
        [
          "Edit",
          { file_path: "/home/user/project/src/a.ts", old_string: "a", new_string: "b" },
          "Edited",
        ],
        [
          "MultiEdit",
          {
            file_path: "/home/user/project/src/b.ts",
            edits: [{ old_string: "x", new_string: "y" }],
          },
          "Edited twice",
        ],
        [
          "NotebookEdit",
          { notebook_path: "/home/user/project/nb.ipynb", new_source: "print(1)" },
          [{ type: "text", text: "Cell 1 replaced" }],
        ],
      ]),
      replied("Done."),
    ],
  },
  {
    name: "unfolded-run",
    records: [
      said("Two quick ones."),
      ...calls("short", [
        ["Bash", { command: "ls" }, "a\nb"],
        ["Read", { file_path: "/tmp/a.txt" }, "hello"],
        ["Bash", { command: "pwd" }],
      ]),
    ],
  },
  {
    name: "search-and-web",
    records: [
      said("Find it."),
      ...calls("search", [
        ["Grep", { pattern: "TODO", path: "/home/user/project" }, "src/a.ts:1: TODO"],
        ["Glob", { pattern: "**/*.test.ts" }, "src/a.test.ts"],
        ["LS", { path: "/home/user/project/src" }, "a.ts\nb.ts"],
        ["WebSearch", { query: "vitest snapshots" }, "Results"],
        ["WebFetch", { url: "https://vitest.dev/guide", prompt: "summarise" }, "A page"],
      ]),
    ],
  },
  {
    name: "agents-and-plans",
    records: [
      said("Plan it."),
      ...calls("plans", [
        [
          "Task",
          { description: "Review the diff", subagent_type: "reviewer", prompt: "Look closely" },
          "Reviewed",
        ],
        ["Agent", { subagent_type: "explorer", prompt: "Map the repo" }, "Mapped"],
        [
          "TodoWrite",
          {
            todos: [
              { content: "one", status: "pending" },
              { content: "two", status: "pending" },
              { content: "three", status: "done" },
            ],
          },
          "Todos updated",
        ],
        ["ExitPlanMode", { plan: "Do the thing" }, "Plan shown"],
        [
          "AskUserQuestion",
          { questions: [{ question: "Which database?", header: "DB", options: [] }] },
          "Answered",
        ],
      ]),
    ],
  },
  {
    name: "novadeck-tools",
    records: [
      said("Use the other terminals."),
      ...calls("novadeck", [
        [`${novadeck}send`, { to: "reviewer", text: "Please look at the diff" }, "Sent"],
        [`${novadeck}send`, { text: "Anyone there?" }, "Sent"],
        [`${novadeck}agents`, {}, "reviewer, builder"],
        [
          `${novadeck}open_agent`,
          { agent: "claude", message: "Review the PR", model: "opus", effort: "high" },
          "Opened terminal 02",
        ],
        [`${novadeck}open_agent`, { agent: "claude", model: "opus", effort: "high" }, "Opened 03"],
        [`${novadeck}open_terminal`, { command: "npm run dev", title: "dev" }, "Opened 03"],
        [`${novadeck}close_terminal`, { to: "builder" }, "Closed"],
        [`${novadeck}close_terminal`, {}, "Closed"],
        [`${novadeck}lead`, { to: "builder", message: "Fix the tests" }, "Asked"],
        [`${novadeck}release`, { to: "builder" }, "Released"],
        [`${novadeck}show`, { page: { url: "http://localhost:5173" } }, "Showing"],
        [`${novadeck}show`, { file: { path: "/home/user/project/docs/plan.md" } }, "Showing"],
        [`${novadeck}close`, { file: { path: "/home/user/project/docs/plan.md" } }, "Closed"],
        [`${novadeck}showing`, {}, "Nothing"],
        [
          `${novadeck}describe`,
          { title: "Chat contract", summary: "Fixing the chat contract." },
          "Saved",
        ],
        ["mcp__github__create_issue", { title: "Flaky test", body: "It flakes" }, "Created #12"],
      ]),
    ],
  },
  {
    name: "limits-and-orphans",
    records: [
      said("Be extreme."),
      ...calls("limits", [
        ["Bash", { command: `echo ${"x".repeat(20_000)}` }, "y".repeat(20_000)],
        [
          `a_very_long_tool_name_${"z".repeat(300)}`,
          { path: "/home/user/project/src/deep/er/file.ts" },
          "fine",
        ],
        ["CustomThing", { query: "something unknown" }, "result of a tool nobody knows"],
      ]),
      orphan("A result whose call fell outside the window."),
    ],
  },
  {
    // Claude Code's messaging, scheduling and bookkeeping tools, their inputs' keys as
    // real transcripts give them.
    name: "messaging-and-scheduling",
    records: [
      said("Coordinate."),
      ...calls("messaging", [
        [
          "SendMessage",
          { to: "reviewer", message: "Please look\nat the diff", summary: "Look" },
          "Sent",
        ],
        ["ListAgents", {}, "reviewer"],
        ["TaskStop", { task_id: "b1x" }, "Stopped"],
        [
          "ScheduleWakeup",
          { delaySeconds: 270, prompt: "Check CI", reason: "Waiting on CI" },
          "Scheduled",
        ],
        ["ScheduleWakeup", { stop: true }, "Stopped"],
        ["CronCreate", { cron: "*/5 * * * *", prompt: "Check the deploy" }, "Created"],
        ["CronList", {}, "1 job"],
        ["CronDelete", { id: "job1" }, "Deleted"],
        ["Skill", { skill: "using-uberepo", args: "status" }, "Loaded"],
        [
          "Monitor",
          { command: "tail -f log", description: "Watch the log", timeout_ms: 60000 },
          "Started",
        ],
        ["ToolSearch", { query: "select:Read", max_results: 1 }, "Found"],
        ["EnterPlanMode", {}, "Entered"],
        ["EnterWorktree", { path: "/home/user/project/.wt/a" }, "Entered"],
        ["ExitWorktree", { action: "keep" }, "Left"],
      ]),
    ],
  },
  {
    name: "interrupted",
    records: [
      said("Start."),
      replied("Working on it."),
      said("[Request interrupted by user]"),
      replied("Stopped."),
    ],
  },
  {
    // The wrappers Claude Code writes around the person's words: a paste (2.1.302 on),
    // slash commands with and without output, and a shell command that couldn't start.
    name: "wrappers",
    records: [
      said(
        'Read this: \n\n<pasted_content id="4f2a">\nfirst pasted line\nsecond pasted line\n</pasted_content id="4f2a">\n and fix it',
      ),
      said('\n\n<pasted_content id="9b1c">\nonly a paste\n</pasted_content id="9b1c">\n'),
      {
        type: "attachment",
        timestamp: stamp,
        attachment: {
          type: "queued_command",
          prompt: 'Also <pasted_content id="7d3e">\nqueued paste\n</pasted_content id="7d3e">\n',
          commandMode: "prompt",
          origin: { kind: "human" },
        },
      },
      {
        type: "user",
        isMeta: true,
        timestamp: stamp,
        message: {
          role: "user",
          content:
            "<local-command-caveat>The command below was run directly in Claude Code.</local-command-caveat>",
        },
      },
      said(
        "<command-name>/mcp</command-name>\n            <command-message>mcp</command-message>\n            <command-args></command-args>",
      ),
      said(
        "<local-command-stdout>\u001b[1mAuthentication successful.\u001b[22m Connected to linear.</local-command-stdout>",
      ),
      said(
        "<command-name>/permissions</command-name>\n<command-message>permissions</command-message>\n<command-args></command-args>",
      ),
      said("<local-command-stdout>(no content)</local-command-stdout>"),
      said(
        "<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>the open pull request</command-args>",
      ),
      replied("Reviewing it."),
      said("<bash-input>ls gone</bash-input>"),
      said(
        '<bash-stderr>Command failed: Working directory "/home/user/gone" was deleted</bash-stderr>',
      ),
    ],
  },
  {
    // Novadeck's reporting tools, their inputs' keys as Claude Code's transcripts give them
    // (seen 2026-11: done {subject, body}, feedback {kind, text}, look {} and {page}), each
    // result a list of text parts; ask and tell as Novadeck's server defines them.
    name: "novadeck-reports",
    records: [
      said("Wrap up."),
      ...calls("reports", [
        [
          `${novadeck}done`,
          { subject: "Chat contract hardened", body: "Fixed four findings." },
          [{ type: "text", text: "Reported." }],
        ],
        [
          `${novadeck}feedback`,
          { kind: "bug", text: "The pane went blank." },
          [{ type: "text", text: "Drafted." }],
        ],
        [`${novadeck}look`, { page: { url: "http://localhost:5173" } }, "Looked"],
        [`${novadeck}look`, {}, "Looked"],
        [`${novadeck}tell`, { subject: "CI is green", body: "All checks." }, "Told."],
        [`${novadeck}ask`, { subject: "Merge it?", body: "It's ready." }, "Asked."],
        [
          `${novadeck}ask`,
          {
            subject: "Which pick?",
            body: "Two ways.",
            shape: { type: "options", options: [{ label: "This" }, { label: "That" }] },
          },
          "Asked.",
        ],
        [
          `${novadeck}ask`,
          {
            subject: "Sign in, please",
            body: "It needs you.",
            shape: { type: "action", command: "gh auth login", done_label: "Signed in" },
          },
          "Asked.",
        ],
        [`${novadeck}ask`, { withdraw: "a-1" }, "Withdrew."],
      ]),
    ],
  },
  {
    // A call of one argument, a string all in quotes: what the agent wrote, quotes and all.
    name: "one-quoted-argument",
    records: [
      said("Run the quoted one."),
      ...calls("quoted", [["Bash", { command: '"/usr/bin/tool"' }, "ran"]]),
    ],
  },
]

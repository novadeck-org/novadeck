import type { Conversation } from "../fixtures"

// Synthetic Claude Code records (see README.md): the JSONL lines Claude Code writes.

const stamp = "2026-10-01T12:00:00.000Z"

const said = (text: string): object => ({
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

const calls = (scenario: string, list: readonly Call[]): object[] =>
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

export const claude: readonly { name: string; records: readonly object[] }[] = [
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
        [`${novadeck}summarize`, { summary: "Fixing the chat contract." }, "Saved"],
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
    name: "interrupted",
    records: [
      said("Start."),
      replied("Working on it."),
      said("[Request interrupted by user]"),
      replied("Stopped."),
    ],
  },
]

export const claudeVocabulary = (): Conversation[] =>
  claude.map(({ name, records }) => ({
    name,
    lines: records.map((record) => JSON.stringify(record)),
  }))

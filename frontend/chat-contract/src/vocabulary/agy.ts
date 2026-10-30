import type { Written } from "../fixtures"

// Synthetic Antigravity steps (see README.md): the JSONL of a conversation's steps.

type Call = readonly [tool: string, args: object, result?: string]

// A step list: the person's request, then the model's response with these calls, and each
// call's result a step on, at the index the decoder pairs it by (the response's plus one
// plus its place in its list).
const turn = (request: string, answer: string, list: readonly Call[], from: number): object[] => [
  {
    step_index: from,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    status: "DONE",
    content: `<USER_REQUEST>\n${request}\n</USER_REQUEST>`,
  },
  {
    step_index: from + 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content: answer,
    tool_calls: list.map(([name, args]) => ({ name, args })),
  },
  ...list.flatMap(([, , result], index) =>
    result === undefined
      ? []
      : [
          {
            step_index: from + 2 + index,
            source: "MODEL",
            type: "GENERIC",
            status: "DONE",
            content: result,
          },
        ],
  ),
]

// Antigravity wraps the strings of its arguments in JSON quotes.
const q = (value: string): string => JSON.stringify(value)

const novadeck = "mcp_novadeck_novadeck_"

export const agyVocabulary: readonly Written[] = [
  {
    name: "files-and-shell",
    records: turn(
      "Look at the project.",
      "On it.",
      [
        ["run_command", { CommandLine: q("npm test"), Cwd: q("/home/user/project") }, "ok"],
        ["view_file", { AbsolutePath: q("/home/user/project/src/index.ts") }, "export {}"],
        ["read_file", { AbsolutePath: "/home/user/project/src/a.ts" }, "a"],
        ["list_dir", { DirectoryPath: "/home/user/project/src" }, "a.ts"],
        [
          "write_to_file",
          { TargetFile: "/home/user/project/n.md", CodeContent: "# n" },
          "Created file",
        ],
        [
          "replace_file_content",
          { TargetFile: "/home/user/project/a.ts", ReplacementContent: "b" },
          "Edited",
        ],
        [
          "multi_replace_file_content",
          { TargetFile: "/home/user/project/b.ts", ReplacementChunks: [] },
          "Edited many",
        ],
      ],
      0,
    ),
  },
  {
    // 1.4's file tools, which name their file as Path, and its run_command, which takes no
    // Cwd (probed 2026-10-20, 1.4.3).
    name: "files-1.4",
    records: turn(
      "Tidy the notes.",
      "Tidying.",
      [
        ["run_command", { CommandLine: q("npm test"), toolSummary: q("Test run") }, "ok"],
        ["read_file", { Path: q("/home/user/project/notes.md") }, "# notes"],
        ["write_file", { Path: "/home/user/project/n.md", Content: "# n" }, "Created file"],
        [
          "edit_file",
          { Path: "/home/user/project/notes.md", Target: "notes", Replacement: "Notes" },
          "Edited",
        ],
      ],
      0,
    ),
  },
  {
    name: "unfolded-run",
    records: turn(
      "Two quick ones.",
      "",
      [
        ["run_command", { CommandLine: "ls" }, "a\nb"],
        ["view_file", { AbsolutePath: "/tmp/a.txt" }],
      ],
      0,
    ),
  },
  {
    name: "search-and-web",
    records: turn(
      "Find it.",
      "Searching.",
      [
        ["grep_search", { Query: "TODO", SearchPath: "/home/user/project" }, "a.ts:1"],
        ["find_by_name", { Pattern: "*.test.ts", SearchDirectory: "/home/user/project" }, "a.test"],
        ["read_url_content", { Url: "https://vitest.dev/guide" }, "A page"],
        ["search_web", { query: "vitest snapshots" }, "Results"],
      ],
      0,
    ),
  },
  {
    name: "novadeck-eager",
    records: turn(
      "Use the other terminals.",
      "Messaging.",
      [
        [`${novadeck}send`, { to: "reviewer", text: "Please look" }, "Sent"],
        [`${novadeck}send`, { text: "Anyone?" }, "Sent"],
        [`${novadeck}agents`, {}, "reviewer"],
        [`${novadeck}open_agent`, { agent: "agy", message: "Review", effort: "high" }, "Opened"],
        [`${novadeck}open_agent`, { agent: "agy", effort: "high", lead: false }, "Opened"],
        [`${novadeck}open_terminal`, { command: "npm run dev" }, "Opened"],
        [`${novadeck}close_terminal`, { to: "builder" }, "Closed"],
        [`${novadeck}close_terminal`, {}, "Closed"],
        [`${novadeck}lead`, { to: "builder", message: "Fix the tests" }, "Asked"],
        [`${novadeck}release`, { to: "builder" }, "Released"],
        [`${novadeck}show`, { page: { url: "http://localhost:5173" } }, "Showing"],
        [`${novadeck}show`, { file: { path: "/home/user/project/plan.md" } }, "Showing"],
        [`${novadeck}close`, { file: { path: "/home/user/project/plan.md" } }, "Closed"],
        [`${novadeck}showing`, {}, "Nothing"],
        [`${novadeck}summarize`, { summary: "Pinning the chat." }, "Saved"],
        ["mcp_github_create_issue", { title: "Flaky test" }, "Created #12"],
      ],
      0,
    ),
  },
  {
    name: "novadeck-lazy",
    records: turn(
      "Use the lazy tool.",
      "Calling.",
      [
        [
          "call_mcp_tool",
          {
            ServerName: q("novadeck"),
            ToolName: q("send"),
            Arguments: q(JSON.stringify({ to: "reviewer", text: "Lazily" })),
          },
          "Sent",
        ],
        [
          "call_mcp_tool",
          { ServerName: "novadeck", ToolName: "agents", Arguments: "{}" },
          "reviewer",
        ],
        [
          "call_mcp_tool",
          {
            ServerName: "novadeck_novadeck",
            ToolName: "open_agent",
            Arguments: { agent: "agy", message: "Review" },
          },
          "Opened",
        ],
        [
          "call_mcp_tool",
          { ServerName: "novadeck", ToolName: "summarize", Arguments: { summary: "Done." } },
          "Saved",
        ],
        [
          "call_mcp_tool",
          { ServerName: "github", ToolName: "create_issue", Arguments: { title: "Flaky" } },
          "Created #12",
        ],
        ["call_mcp_tool", { ServerName: "github" }, "No tool named"],
      ],
      0,
    ),
  },
  {
    name: "limits",
    records: turn(
      "Be extreme.",
      "",
      [
        ["run_command", { CommandLine: `echo ${"x".repeat(20_000)}` }, "y".repeat(20_000)],
        [`a_very_long_tool_name_${"z".repeat(300)}`, { path: "/home/user/project/f.ts" }, "fine"],
        ["unknown_tool", { query: "something" }, "result"],
      ],
      0,
    ),
  },
]

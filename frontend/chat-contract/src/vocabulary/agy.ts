import type { Written } from "../fixtures"

// Synthetic Antigravity steps (see README.md): the JSONL of a conversation's steps.

type Call = readonly [tool: string, args: object, result?: string]

// A step list: the person's request, then the model's response with these calls, and each
// call's result a step on, at the index the decoder pairs it by (the response's plus one
// plus its place in its list).
export const turn = (
  request: string,
  answer: string,
  list: readonly Call[],
  from: number,
): object[] => [
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

// What invoke_subagent's result says: the subagent it started.
const launch = (conversation: string): string =>
  `Created At: 2026-11-09T14:54:49+01:00\nCompleted At: 2026-11-09T14:54:49+01:00\nCreated the following subagent:\n{\n  "conversationId":  "${conversation}",\n  "workspaceUris":  [\n    "file:///home/user/project"\n  ]\n}\nThe subagent will send you a message when it has completed its task or requires guidance. There is no need to poll for its response.`

const novadeck = "mcp_novadeck_novadeck_"

export const agyVocabulary: readonly Written[] = [
  {
    name: "files-and-shell",
    records: turn(
      "Look at the project.",
      "On it.",
      [
        ["run_command", { CommandLine: "npm test", Cwd: "/home/user/project" }, "ok"],
        ["view_file", { AbsolutePath: "/home/user/project/src/index.ts" }, "export {}"],
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
        ["run_command", { CommandLine: "npm test", toolSummary: "Test run" }, "ok"],
        ["read_file", { Path: "/home/user/project/notes.md" }, "# notes"],
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
    name: "subagents-and-asking",
    // invoke_subagent's result is only the launch, the subagent's report coming as the
    // message its going idle wakes the root with: one reports, one still runs (probed
    // 2026-11-09, 1.5.2, harnesses/agy's fixtures/subagent-transcript.probe.json).
    records: [
      ...turn(
        "Split it up.",
        "Delegating.",
        [
          [
            "invoke_subagent",
            {
              TypeName: "self",
              Role: "Background helper",
              Prompt: "Work in the background.",
            },
            launch("00000000-0000-4000-8000-000000000002"),
          ],
          [
            "invoke_subagent",
            { TypeName: "self", Role: "Slow helper", Prompt: "Take your time." },
            launch("00000000-0000-4000-8000-000000000003"),
          ],
          ["define_subagent", { TypeName: "tester", Role: "Runs the tests" }, "Defined"],
          ["manage_subagents", { Action: "list" }, "tester"],
          ["send_message", { Message: "Also the lint\nplease", toolSummary: "Message" }, "Sent"],
          ["manage_task", { Action: "kill", toolSummary: "Stop it" }, "Killed"],
          ["schedule", { DurationSeconds: 60, Prompt: "Check the build" }, "Scheduled"],
          [
            "ask_question",
            {
              questions: [
                {
                  question: "Which branch?",
                  options: ["main", "dev"],
                  is_multi_select: false,
                },
              ],
            },
            "main",
          ],
        ],
        0,
      ),
      {
        step_index: 20,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        content:
          "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-09T13:54:53Z sender=system priority=MESSAGE_PRIORITY_HIGH content=Subagent 00000000-0000-4000-8000-000000000002 has gone idle. This was the subagent's most recent response: The build is green.\n</SYSTEM_MESSAGE>",
      },
    ],
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
        [`${novadeck}team`, { all: true }, "Your team"],
        [`${novadeck}open_agent`, { agent: "agy", message: "Review", effort: "high" }, "Opened"],
        [`${novadeck}open_agent`, { agent: "agy", effort: "high", lead: false }, "Opened"],
        [`${novadeck}open_terminal`, { command: "npm run dev" }, "Opened"],
        [`${novadeck}close_terminal`, { to: "builder" }, "Closed"],
        [`${novadeck}close_terminal`, {}, "Closed"],
        [`${novadeck}open_worktree`, { branch: "feat/login" }, "Opened"],
        [`${novadeck}take_worktree`, { path: "/home/user/.novadeck/worktrees/p/g/api" }, "Took"],
        [
          `${novadeck}give_worktree`,
          { path: "/home/user/.novadeck/worktrees/p/g/api", to: "builder" },
          "Gave",
        ],
        [
          `${novadeck}close_worktree`,
          { path: "/home/user/.novadeck/worktrees/p/g/api", force: true },
          "Closed",
        ],
        [`${novadeck}lead`, { to: "builder", message: "Fix the tests" }, "Asked"],
        [`${novadeck}release`, { to: "builder" }, "Released"],
        [`${novadeck}show`, { page: { url: "http://localhost:5173" } }, "Showing"],
        [`${novadeck}show`, { file: { path: "/home/user/project/plan.md" } }, "Showing"],
        [`${novadeck}close`, { file: { path: "/home/user/project/plan.md" } }, "Closed"],
        [`${novadeck}showing`, {}, "Nothing"],
        [`${novadeck}describe`, { title: "Chat pinning", summary: "Pinning the chat." }, "Saved"],
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
            ServerName: "novadeck",
            ToolName: "send",
            Arguments: JSON.stringify({ to: "reviewer", text: "Lazily" }),
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
          {
            ServerName: "novadeck",
            ToolName: "describe",
            Arguments: { title: "Chat", summary: "Done." },
          },
          "Saved",
        ],
        [
          "call_mcp_tool",
          { ServerName: "github", ToolName: "create_issue", Arguments: { title: "Flaky" } },
          "Created #12",
        ],
        ["call_mcp_tool", { ServerName: "github" }, "No tool named"],
        [
          "call_mcp_tool",
          {
            ServerName: "novadeck",
            ToolName: "ask",
            Arguments: {
              subject: "Which pick?",
              body: "Two ways.",
              shape: { type: "options", options: [{ label: "This" }] },
            },
          },
          "Asked.",
        ],
        [
          "call_mcp_tool",
          {
            ServerName: "novadeck",
            ToolName: "tell",
            Arguments: { subject: "CI is green", body: "All checks." },
          },
          "Told.",
        ],
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
  {
    // Novadeck's reporting tools, their inputs' keys as Novadeck's server defines them and
    // Claude Code's transcripts record them.
    name: "novadeck-reports",
    records: turn(
      "Wrap up.",
      "Reporting.",
      [
        [
          `${novadeck}done`,
          { subject: "Chat contract hardened", body: "Fixed four findings." },
          "Reported.",
        ],
        [`${novadeck}feedback`, { kind: "bug", text: "The pane went blank." }, "Drafted."],
        [`${novadeck}look`, { page: { url: "http://localhost:5173" } }, "Looked"],
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
        [`${novadeck}ask`, { withdraw: "00000000-0000-4000-8000-000000000001" }, "Withdrew."],
      ],
      0,
    ),
  },
  {
    // A call of one argument, a string all in quotes: what the agent wrote, quotes and all.
    name: "one-quoted-argument",
    records: turn(
      "Run the quoted one.",
      "Running.",
      [["run_command", { CommandLine: '"/usr/bin/tool"' }, "ok"]],
      0,
    ),
  },
  {
    // A prompt that carried images (from 1.4.9): listed apart from the words, as media saved
    // under the session; and one of 1.4.3, whose path stayed in its words.
    name: "image-prompts",
    records: [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        content: "<USER_REQUEST>\nCompare [Image #1] with [Image #2]\n</USER_REQUEST>",
        media: [
          {
            mime_type: "image/png",
            uri: "/home/user/.gemini/antigravity-cli/brain/s/.user_uploaded/a.png",
          },
          {
            mime_type: "image/jpeg",
            uri: "file:///home/user/.gemini/antigravity-cli/brain/s/.user_uploaded/b.jpg",
          },
        ],
      },
      ...turn("Is it the same as /work/c.png?", "Looking.", [], 1),
    ],
  },
]

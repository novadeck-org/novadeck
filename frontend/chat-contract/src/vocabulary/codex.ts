import type { Written } from "../fixtures"

// Synthetic Codex rollout records (see README.md): the response items of a rollout.

const stamp = "2026-10-01T12:00:00.000Z"

const item = (payload: object): object => ({ timestamp: stamp, type: "response_item", payload })

const said = (text: string): object =>
  item({ type: "message", role: "user", content: [{ type: "input_text", text }] })

const replied = (text: string): object =>
  item({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })

// A call is [tool, input, output]; an object input is a function call's JSON arguments, a
// string one a custom tool's raw input. Output left out is a call still running; an array
// is the list of text parts Codex writes some outputs as.
type Call = readonly [
  tool: string,
  input: object | string,
  output?: string | { type: "input_text"; text: string }[],
  namespace?: string,
]

const calls = (scenario: string, list: readonly Call[]): object[] =>
  list.flatMap(([name, input, output, namespace], index) => {
    const call_id = `call_${scenario}_${index}`
    const custom = typeof input === "string"
    return [
      item({
        type: custom ? "custom_tool_call" : "function_call",
        name,
        ...(namespace && { namespace }),
        ...(custom ? { input } : { arguments: JSON.stringify(input) }),
        call_id,
      }),
      ...(output === undefined
        ? []
        : [
            item({
              type: custom ? "custom_tool_call_output" : "function_call_output",
              call_id,
              output,
            }),
          ]),
    ]
  })

const patch = (files: readonly string[]): string =>
  [
    "*** Begin Patch",
    ...files.flatMap((file, index) =>
      index === 0
        ? [`*** Add File: ${file}`, "+hello"]
        : index === 1
          ? [`*** Update File: ${file}`, "@@", "-old", "+new"]
          : [`*** Delete File: ${file}`],
    ),
    "*** End Patch",
  ].join("\n")

const text = (value: string) => [{ type: "input_text" as const, text: value }]

export const codexVocabulary: readonly Written[] = [
  {
    name: "shell-tools",
    records: [
      said("Run things."),
      ...calls("shell", [
        ["shell", { command: ["bash", "-lc", "npm test"] }, "Exit code: 0\nok"],
        ["shell", { command: ["ls", "-la", "src"] }, "a\nb"],
        ["shell_command", { command: "git status", workdir: "/home/user/project" }, "clean"],
        ["local_shell", { command: ["echo", "local"] }, "local"],
        ["container.exec", { command: ["bash", "-c", "echo hi"] }, "hi"],
        ["exec_command", { cmd: "rg -n foo src", yield_time_ms: 1000 }, text("Chunk ID: 1\nfoo")],
        ["exec", "text.ls({ path: '.' })", text("a.ts")],
        ["write_stdin", { session_id: 1, chars: "y\n" }, "accepted"],
      ]),
    ],
  },
  {
    name: "patches-and-plans",
    records: [
      said("Change files."),
      ...calls("patch", [
        [
          "apply_patch",
          patch(["/home/user/project/a.ts", "/home/user/project/b.ts", "/home/user/project/c.ts"]),
          text("Success. Updated 3 files"),
        ],
        ["apply_patch", { input: patch(["/home/user/project/only.ts"]) }, "Success"],
        [
          "update_plan",
          {
            plan: [
              { step: "read", status: "completed" },
              { step: "edit", status: "in_progress" },
              { step: "test", status: "pending" },
            ],
          },
          "Plan updated",
        ],
        ["view_image", { path: "/home/user/project/shot.png" }, "image"],
      ]),
    ],
  },
  {
    name: "novadeck-tools",
    records: [
      said("Use the other terminals."),
      ...calls("novadeck", [
        ["send", { to: "reviewer", text: "Please look" }, "Sent", "mcp__novadeck"],
        ["send", { text: "Anyone?" }, "Sent", "mcp__novadeck"],
        ["agents", {}, "reviewer", "mcp__novadeck"],
        [
          "open_agent",
          { agent: "codex", message: "Review", effort: "high" },
          "Opened",
          "mcp__novadeck",
        ],
        [
          "open_agent",
          { agent: "codex", model: "gpt-5", effort: "high" },
          "Opened",
          "mcp__novadeck",
        ],
        ["open_terminal", { command: "npm run dev" }, "Opened", "mcp__novadeck"],
        ["close_terminal", { to: "builder" }, "Closed", "mcp__novadeck"],
        ["close_terminal", {}, "Closed", "mcp__novadeck"],
        ["lead", { to: "builder", message: "Fix the tests" }, "Asked", "mcp__novadeck"],
        ["release", { to: "builder" }, "Released", "mcp__novadeck"],
        ["show", { page: { url: "http://localhost:5173" } }, "Showing", "mcp__novadeck"],
        ["show", { file: { path: "/home/user/project/plan.md" } }, "Showing", "mcp__novadeck"],
        ["close", { file: { path: "/home/user/project/plan.md" } }, "Closed", "mcp__novadeck"],
        ["showing", {}, "Nothing", "mcp__novadeck"],
        ["look", { page: { url: "http://localhost:5173" } }, "Looked", "mcp__novadeck"],
        ["summarize", { summary: "Pinning the chat." }, "Saved", "mcp__novadeck"],
        ["mcp__novadeck.send", { to: "reviewer", text: "dotted spelling" }, "Sent"],
        ["mcp__novadeck__agents", {}, "reviewer"],
        ["create_issue", { title: "Flaky test" }, "Created #12", "mcp__github"],
      ]),
    ],
  },
  {
    name: "limits-and-orphans",
    records: [
      said("Be extreme."),
      ...calls("limits", [
        [
          "apply_patch",
          `${patch(["/home/user/project/big.ts"])}\n${"+x".repeat(12_000)}`,
          "Success",
        ],
        [`a_very_long_tool_name_${"z".repeat(300)}`, { path: "/home/user/project/f.ts" }, "fine"],
        ["unknown_tool", { query: "something" }, "result"],
      ]),
      item({ type: "function_call_output", call_id: "call_gone", output: "Orphaned result" }),
    ],
  },
  {
    name: "agent-message-and-interruption",
    records: [
      said("Start."),
      replied("Working."),
      item({
        type: "agent_message",
        author: "/root/reviewer",
        content: text("Found two problems."),
      }),
      item({ type: "agent_message", content: text("From a subagent that gave no name.") }),
      said("[Request interrupted by user]"),
    ],
  },
]

// The agent harnesses Novadeck identifies and can resume, one row each, in the order
// people see them: where a harness is listed, its row is its place. Data only, so the UI,
// the runner and the adapters read the same table; what a harness does lives in its
// adapter. Adding a harness starts with a row here.
export const harnesses = [
  {
    id: "claude",
    // As people call it, and as a short word in a sentence.
    name: "Claude Code",
    shortName: "Claude",
    // The script a node foreground process runs, where the CLI is a node program (the
    // others are native, so their process names say who they are).
    nodeScript: "/@anthropic-ai/claude-code/cli.js",
    // Variables an agent session sets on its children, which Novadeck's shells must not pass on.
    inheritedEnv: [
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_SESSION_ATTENDED",
      "CLAUDE_PID",
      "CLAUDE_PROJECT_DIR",
    ],
    secretPaths: [],
    // Whether its conversation records a `!` shell command and its output, so a chat can
    // show them.
    recordsShell: true,
  },
  {
    id: "codex",
    name: "Codex",
    shortName: "Codex",
    nodeScript: "/@openai/codex/bin/codex.js",
    inheritedEnv: ["CODEX_THREAD_ID"],
    // Case-insensitive regex sources, matched against a resolved path: where the
    // harness keeps a login under a name too plain to hold everywhere.
    secretPaths: ["[\\\\/]\\.codex[\\\\/]auth\\.json$"],
    recordsShell: true,
  },
  {
    id: "agy",
    name: "Antigravity",
    shortName: "Antigravity",
    nodeScript: undefined,
    inheritedEnv: ["ANTIGRAVITY_CONVERSATION_ID"],
    secretPaths: [],
    // It runs the command, but keeps no record of it: the output shows only in the terminal.
    recordsShell: false,
  },
] as const satisfies readonly {
  readonly id: string
  readonly name: string
  readonly shortName: string
  readonly nodeScript: string | undefined
  readonly inheritedEnv: readonly string[]
  readonly secretPaths: readonly string[]
  readonly recordsShell: boolean
}[]

/** A harness's id: the agent names the protocol speaks. */
export type HarnessId = (typeof harnesses)[number]["id"]

/** The harness ids, in table order. */
export const harnessIds = harnesses.map(({ id }) => id) as unknown as readonly [
  HarnessId,
  ...HarnessId[],
]

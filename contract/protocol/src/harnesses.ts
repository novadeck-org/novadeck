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
    // Its login file, `.credentials.json`, holds secrets by that name wherever
    // `CLAUDE_CONFIG_DIR` puts its home.
    logins: [],
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
    // Where the harness keeps a login under a name too plain to hold everywhere: `file`
    // in its home, which is a folder named `folder`, the one `variable` names, or any that
    // holds one of `beside`, which it keeps there: a home moved for one terminal alone, or
    // a copy of one, which no variable the runner reads names. Its names match in any case.
    logins: [
      {
        file: "auth.json",
        folder: ".codex",
        variable: "CODEX_HOME",
        beside: ["config.toml", "sessions", "history.jsonl", "version.json"],
      },
    ],
    recordsShell: true,
  },
  {
    id: "agy",
    name: "Antigravity",
    shortName: "Antigravity",
    nodeScript: undefined,
    inheritedEnv: ["ANTIGRAVITY_CONVERSATION_ID"],
    // It keeps its login in the system's keyring, or without one in its home as
    // `antigravity-oauth-token`; that and Gemini's `oauth_creds.json`, beside its home, hold
    // secrets by those names wherever the folders are.
    logins: [],
    // It runs the command, but keeps no record of it: the output shows only in the terminal.
    recordsShell: false,
  },
] as const satisfies readonly {
  readonly id: string
  readonly name: string
  readonly shortName: string
  readonly nodeScript: string | undefined
  readonly inheritedEnv: readonly string[]
  readonly logins: readonly {
    readonly file: string
    readonly folder: string
    readonly variable: string
    readonly beside: readonly string[]
  }[]
  readonly recordsShell: boolean
}[]

/** A harness's id, which the protocol names an agent by. */
export type AgentName = (typeof harnesses)[number]["id"]

/** The agent names, in the harness table's order. */
export const agentNames = harnesses.map(({ id }) => id) as unknown as readonly [
  AgentName,
  ...AgentName[],
]

/**
 * Whether `name` is an agent this build knows. A newer build may know more harnesses and
 * keep their names in data an older one reads, as a portable copy opening the newer one's
 * workspace: what reads a kept name checks it, so an unknown one degrades, never fails a
 * whole listing.
 */
export const isAgentName = (name: unknown): name is AgentName =>
  (agentNames as readonly unknown[]).includes(name)

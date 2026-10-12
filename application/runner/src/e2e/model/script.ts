/**
 * A model call as the fake model sees it: the same shape whichever API the harness
 * speaks, so a scenario's rules read the conversation without knowing the wire format.
 */
export type Call = {
  readonly api: Api
  readonly model: string
  /** The system, developer and instruction text, joined. */
  readonly system: string
  /** The conversation, oldest first, as the model would see it. */
  readonly turns: readonly Turn[]
  /** The tools offered, by the names the harness gives them. */
  readonly tools: readonly string[]
  /**
   * A call the harness makes for itself rather than for the agent's turn, such as a
   * title or a summary, as its API tells it; false when it can't tell.
   */
  readonly side: boolean
}

/** The APIs the harnesses speak: Claude Code's, Codex's and Antigravity's, in that order. */
export type Api = "anthropic" | "responses" | "gemini"

/**
 * One entry of the conversation. A user turn holds everything the harness put in it,
 * the prompt and any context a hook added beside it, joined.
 */
export type Turn =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly text: string; readonly calls: readonly ToolCall[] }
  | { readonly role: "tool"; readonly id: string; readonly text: string }

export type ToolCall = {
  readonly id: string
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
}

/**
 * What the fake model answers: text, tool calls, or both, and, where the API reports them
 * with an answer, the account's limits and the answer's usage.
 */
export type Reply = {
  readonly text?: string
  readonly calls?: readonly Omit<ToolCall, "id">[]
  /**
   * How much of the account's rate limits the answer says is used, in percent, both its
   * short and its long window, as Codex reads them from the Responses API's headers.
   * None are reported unless given.
   */
  readonly limits?: { readonly usedPercent: number }
  /**
   * The output tokens the answer says it took, in place of the dialect's own count, as
   * Claude Code prices its session by them from the Messages API. Only that dialect
   * reports it.
   */
  readonly usage?: { readonly outputTokens: number }
}

/**
 * Answers a call, or leaves it to the next rule. A rule may take its time: the harness
 * waits for the answer as it would for a slow model, so a test can hold a reply until it
 * lets it go (see `gate`).
 */
export type Rule = (call: Call) => Reply | undefined | Promise<Reply | undefined>

/** The answer when no rule takes a call. */
export const fallback: Reply = { text: "OK." }

/**
 * Thrown by a rule, the model refuses the call with an HTTP `status`, as an API rejecting
 * a request does: an answer in its own right, never a failure of the fake model's.
 */
export class Refusal extends Error {
  constructor(readonly status: number) {
    super(`refused with ${status}`)
  }
}

/** The first reply a rule gives, or the fallback. */
export const answer = async (rules: readonly Rule[], call: Call): Promise<Reply> => {
  for (const rule of rules) {
    // eslint-disable-next-line no-await-in-loop -- Rules are asked in order, one at a time.
    const reply = await rule(call)
    if (reply) return reply
  }
  return fallback
}

/**
 * A gate a rule can hold its reply at until the test opens it: the rule awaits `opened`,
 * and the harness waits with it, mid-turn, as on a slow model. Opening it again does
 * nothing.
 */
export const gate = (): { readonly open: () => void; readonly opened: Promise<void> } => {
  let release!: () => void
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { open: () => release(), opened }
}

/** All of a call's text, in order: what a scenario looks for when it doesn't mind where. */
export const text = (call: Call): string =>
  [
    call.system,
    ...call.turns.map((turn) =>
      turn.role === "assistant"
        ? [
            turn.text,
            ...turn.calls.map((tool) => `${tool.name} ${JSON.stringify(tool.input)}`),
          ].join("\n")
        : turn.text,
    ),
  ].join("\n")

/** The latest user turn's text, or "" when the call has none. */
export const latest = (call: Call): string =>
  call.turns.findLast((turn) => turn.role === "user")?.text ?? ""

/**
 * The name a harness gives one of Novadeck's MCP tools (`send`, `agents`, `open_terminal`),
 * as each prefixes it its own way (Claude Code's `mcp__plugin_novadeck_novadeck__send`);
 * undefined when the call doesn't offer it.
 */
export const tool = (call: Call, name: string): string | undefined =>
  call.tools.find(
    (offered) => offered === name || new RegExp(`novadeck[\\W_]+${name}$`).test(offered),
  )

/**
 * Whether a user turn holding `words` came after the model last answered: the call is the
 * model's first look at it, not one after its tool calls ran. A rule that answers with a
 * tool call checks this, or it would call the tool again with every result.
 */
export const asked = (call: Call, words: string): boolean =>
  call.turns.findLastIndex((turn) => turn.role === "user" && turn.text.includes(words)) >
  call.turns.findLastIndex((turn) => turn.role === "assistant")

/**
 * The models Nova runs on, which Novadeck pays for: GPT-6 Luna, GPT-6.1 Terra and GPT-6.2 Sol,
 * through Nova's model service on Novadeck's website, which takes OpenAI's Chat Completions and
 * passes them to OpenRouter with Novadeck's key, for those three models alone and on the provider
 * it sets, whatever is sent (novadeck-website's src/nova). Nothing of it is written anywhere:
 * Novadeck's extension registers it in Nova alone (`pi.registerProvider`), from two variables
 * Nova's launcher gets from the runner (`ticket.ts`), which the extension takes out of pi's
 * environment before anything runs, so no command of the agent's sees them.
 *
 * Probed 2026-11-25 with pi 1.6.0 against a local server and the live service: pi sends `POST
 * <base>/chat/completions` with `Authorization: Bearer <key>`, `"stream": true`,
 * `"stream_options": {"include_usage": true}`, `"max_completion_tokens"` and the thinking level as
 * `"reasoning": {"effort": "medium"}` (`thinkingFormat: "openrouter"`), its tools as functions;
 * the service answers its stream, tool calls and usage (cache reads included), and takes the
 * reasoning pi replays in the next call.
 */

/** The provider's name in pi; `--model` takes a model as `nova/gpt-6-luna`. */
export const novaProvider = "nova"

/** The models' ids, as pi and Nova's model service name them. */
export const novaModelIds = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol"] as const
export type NovaModelId = (typeof novaModelIds)[number]

/** A model as `--model` takes it: `nova/<id>`. */
export const novaModel = (id: NovaModelId): string => `${novaProvider}/${id}`

/** The model a new session of Nova starts on, and the tour's: Luna, the cheapest. */
export const novaDefaultModelId: NovaModelId = "gpt-6-luna"
export const novaDefaultModel = novaModel(novaDefaultModelId)

/**
 * Where the provider points in Nova where its launcher got no service (the service refused or
 * didn't answer): a port of this computer's that nothing listens on, so a session of its models
 * fails at once, never going on with another model on the person's own keys.
 */
export const novaUnavailable = "http://127.0.0.1:9/nova-unavailable"

/** The variables Nova's launcher is given the service's base URL and key in. */
export const novaService = {
  baseUrl: "NOVADECK_NOVA_BASE_URL",
  key: "NOVADECK_NOVA_KEY",
} as const

/**
 * The thinking levels pi offers each model and the effort it sends for each, as pi's own
 * catalogue has them for these models on OpenRouter (packages/ai's providers/data/openrouter.json,
 * 1.6.0): every level from low to max, pi's `off` as OpenAI's `none` where the model takes it
 * (Luna and Terra; Sol always reasons), and no `minimal`, which these models don't take. pi offers
 * `xhigh` and `max` only for a model whose map names them (`getSupportedThinkingLevels`).
 */
const levels = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const

/**
 * Each model as pi takes it: its own figures (OpenRouter's, 2026-11-27: 1.05M tokens of context,
 * priced per million tokens), its context held under the 272k past which it costs more, and its
 * answer at the service's cap (32,000 tokens).
 */
const model = (
  id: NovaModelId,
  name: string,
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
  thinkingLevelMap: { readonly [level: string]: string | null },
) => ({
  id,
  name,
  reasoning: true,
  input: ["text"],
  cost,
  contextWindow: 272_000,
  maxTokens: 32_000,
  thinkingLevelMap,
  compat: {
    thinkingFormat: "openrouter",
    maxTokensField: "max_completion_tokens",
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
  },
})

/**
 * The provider as the extension registers it, but for its base URL and key. Its compatibility
 * is said outright, as pi guesses it from a base URL it knows and Novadeck's is none of those:
 * OpenRouter's reasoning field, `max_completion_tokens`, no `store`, and the system prompt as a
 * system message.
 */
export const novaProviderConfig = {
  name: "Nova",
  api: "openai-completions",
  authHeader: true,
  models: [
    model(
      "gpt-6-luna",
      "GPT-6 Luna",
      { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      levels,
    ),
    model(
      "gpt-6.1-terra",
      "GPT-6.1 Terra",
      { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
      levels,
    ),
    model(
      "gpt-6.2-sol",
      "GPT-6.2 Sol",
      { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      { ...levels, off: null },
    ),
  ],
}

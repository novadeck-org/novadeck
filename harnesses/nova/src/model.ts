/**
 * The model Novadeck's own pi runs on where Novadeck pays for it (the tour's): GPT-6 Luna, through
 * Novadeck's model service on its website, which takes OpenAI's Chat Completions and passes them
 * to OpenRouter with Novadeck's key, the model and its provider set there whatever is sent
 * (novadeck-website's src/tour). Nothing of it is written anywhere: Novadeck's extension registers
 * it in Novadeck's own pi alone (`pi.registerProvider`), from two variables of the terminal it
 * starts in, which a terminal gets only where Novadeck pays (the tour's folder), and which the
 * extension takes out of pi's environment before anything runs, so no command of the agent's
 * sees them.
 *
 * Probed 2026-11-25 with pi 1.6.0 against a local server and the live service: pi sends `POST
 * <base>/chat/completions` with `Authorization: Bearer <key>`, `"stream": true`,
 * `"stream_options": {"include_usage": true}`, `"max_completion_tokens"` and the thinking level as
 * `"reasoning": {"effort": "medium"}` (`thinkingFormat: "openrouter"`), its tools as functions;
 * the service answers its stream, tool calls and usage (cache reads included), and takes the
 * reasoning pi replays in the next call.
 */

/** The provider's name in pi, and the model's id there; `--model` takes them as `novadeck/gpt-6-luna`. */
export const ownProvider = "novadeck"
export const ownModelId = "gpt-6-luna"
export const ownModel = `${ownProvider}/${ownModelId}`

/**
 * Where the provider points in Novadeck's pi where its terminal has no service (outside the
 * tour): a port of this computer's that nothing listens on, so a session of the model resumed
 * there fails at once, never going on with another model on the person's own keys.
 */
export const ownUnavailable = "http://127.0.0.1:9/novadeck-unavailable"

/** The variables a terminal of Novadeck's pi is given the service's base URL and key in. */
export const ownService = {
  baseUrl: "NOVADECK_PI_BASE_URL",
  key: "NOVADECK_PI_KEY",
} as const

/**
 * The provider as the extension registers it, but for its base URL and key: GPT-6 Luna's own
 * figures (OpenRouter's, 2026-11-25: 1.05M tokens of context, priced per million tokens), its
 * context held under the 272k past which it costs double, and its answer at the service's cap
 * (32,000 tokens). Its compatibility is said outright, as pi guesses it from a base URL it knows
 * and Novadeck's is none of those: OpenRouter's reasoning field, `max_completion_tokens`, no
 * `store`, and the system prompt as a system message.
 */
export const ownProviderConfig = {
  name: "Novadeck",
  api: "openai-completions",
  authHeader: true,
  models: [
    {
      id: ownModelId,
      name: "GPT-6 Luna",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      contextWindow: 272_000,
      maxTokens: 32_000,
      compat: {
        thinkingFormat: "openrouter",
        maxTokensField: "max_completion_tokens",
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
      },
    },
  ],
} as const

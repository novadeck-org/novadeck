import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { trustedIn } from "../../harnesses/codex/trust.js"
import { responses } from "../model/responses.js"
import type { Sandbox } from "../sandbox.js"
import type { AgentSetup } from "./agent.js"

// The variable Codex reads the fake credential from, as its model provider names it.
const key = "NOVADECK_E2E_CODEX_KEY"

const config = (sandbox: Sandbox, url: string, trusted: boolean): string =>
  `# Codex against NovaDeck's fake model, for end-to-end tests.
model = "fake-model"
model_provider = "novadeck-e2e"
# Its ChatGPT backend, which it asks for featured plugins on the way to its prompt.
chatgpt_base_url = ${JSON.stringify(`${url}/backend-api/`)}
check_for_update_on_startup = false
# Its login and MCP servers' credentials in files of its home, never the keyring, whatever
# a later Codex makes the default (MCP's is "auto" in 0.159.3, keyring first).
cli_auth_credentials_store = "file"
mcp_oauth_credentials_store = "file"

# Its usage analytics and the metrics it sends to Statsig.
[analytics]
enabled = false

[otel]
metrics_exporter = "none"

[model_providers.novadeck-e2e]
name = "NovaDeck e2e"
base_url = ${JSON.stringify(`${url}/v1`)}
env_key = "${key}"
wire_api = "responses"
${trusted ? `\n[projects.${JSON.stringify(sandbox.project)}]\ntrust_level = "trusted"\n` : ""}`

/**
 * Codex against the fake model: its own home in the sandbox, with a model provider of
 * its own speaking the Responses API to the fake model, its update check off and the
 * project trusted. Without an OpenAI login it shows no sign-in screen for such a provider.
 * Seeded with `folderTrusted: false`, it trusts no folder and shows "Trust this folder?";
 * with `hooksTrusted: false`, NovaDeck's hooks are left for its "Hooks need review" screen,
 * which comes a few seconds after its prompt drew (probed 2026-10-02, 0.159.3). Behind
 * either, NovaDeck sees no prompt: its title says nothing, or its hooks don't run.
 */
export const codex: AgentSetup = {
  agent: "codex",
  name: "Codex",
  dialect: responses,
  banner: "OpenAI Codex",
  bindsAtReady: false,
  // Its curated-plugin sync and its startup tips (see `prepare`).
  refused: ["github.com", "api.github.com", "raw.githubusercontent.com"],
  watch: {
    searched: [".codex/config.toml"],
    listed: [],
    // Its login, and NovaDeck's copy among its installed plugins. Not the plugins' folder
    // itself: the developer's own Codex refreshes its bundled plugins there whenever it
    // likes, which would trip it with nothing leaked.
    stamped: [".codex/auth.json", ".codex/plugins/cache/novadeck"],
  },
  hosts: ["api.openai.com", "chatgpt.com", "auth.openai.com", "ab.chatgpt.com"],
  // Its approval policy, as the trusted project leaves it (`on-request`), runs commands in
  // its sandbox without asking; one the model asks to run outside it does ask, as "Would
  // you like to run the following command?", its first choice, running it, selected. It
  // has no plain "no": Esc, its third choice, cancels the command and interrupts the turn,
  // which then ends with its Interrupt hook, not a Stop.
  approval: {
    request: () => ({
      calls: [
        {
          name: "exec_command",
          input: {
            cmd: "echo approved",
            sandbox_permissions: "require_escalated",
            justification: "Echo outside the sandbox",
          },
        },
      ],
    }),
    shows: /› 1\. Yes, proceed \(y\)/,
    deny: "\x1b",
    denied: /✗ You canceled the request to run/,
  },
  // Escape mid-turn says so (probed 2026-10-02, 0.159.3).
  interrupted: () => /■ Conversation interrupted/,
  // No `background`: nothing a Codex agent starts wakes it once its turn has ended (probed
  // 2026-10-02, 0.159.3). A subagent from `spawn_agent` (`multi_agent_v1`, the default,
  // and `collaboration` with `features.multi_agent_v2`) and a command `exec_command` left
  // running (a "background terminal") each finished with the root idle and no model call
  // for 20 s after. A v1 subagent's `<subagent_notification>` only goes with the person's
  // next prompt, and a v2 one's end with none. NovaDeck rightly calls such a root Settled.
  absent: {
    background: "nothing it starts wakes it once its turn has ended (probed 2026-10-02, 0.159.3)",
  },
  // Its folder-trust question, "Trust this folder?", has trusting it selected, and its
  // "Hooks need review" screen says "esc skip", which goes on without trusting them.
  trust: {
    folder: {
      shows: /› 1\. Trust and continue/,
      select: "",
      trusts: /› 1\. Trust and continue/,
    },
    hooks: { shows: /Hooks need review/, skip: "\x1b" },
  },
  // Its hooks can be trusted only once NovaDeck's plugin is in.
  connected: (sandbox, _model, seed) =>
    trustHooks(sandbox, { hooks: seed?.hooksTrusted !== false }),
  prepare: async (sandbox, model, _installed, seed) => {
    const home = join(sandbox.home, ".codex")
    await mkdir(home, { recursive: true, mode: 0o700 })
    await writeFile(
      join(home, "config.toml"),
      config(sandbox, model.url, seed?.folderTrusted !== false),
    )
    // Codex syncs OpenAI's curated plugins from GitHub at start, and only without a copy
    // of its own falls back to an archive from chatgpt.com; an empty copy keeps it off
    // that host. The GitHub attempts are refused by the fake model's proxy.
    const curated = join(home, ".tmp", "plugins", ".agents", "plugins")
    await mkdir(curated, { recursive: true })
    await writeFile(
      join(curated, "marketplace.json"),
      JSON.stringify({ name: "openai-curated", plugins: [] }),
    )
    await writeFile(join(home, ".tmp", "plugins.sha"), `${"0".repeat(40)}\n`)
    return { CODEX_HOME: home, [key]: model.credential }
  },
}

type Message = { readonly id?: unknown; readonly result?: unknown; readonly error?: unknown }

/**
 * A session with Codex's app-server over stdio, as its TUI and NovaDeck talk to it: each
 * request resolves to its result, or fails with its error, after `timeoutMs`, or as soon
 * as the app-server can't answer, as it failed to start or exited.
 */
const appServer = (env: Readonly<Record<string, string>>, timeoutMs = 20_000) => {
  const child = spawn("codex", ["app-server"], {
    env,
    cwd: env.HOME,
    stdio: ["pipe", "pipe", "ignore"],
  })
  const pending = new Map<number, (message: Message | Error) => void>()
  // Why the app-server can't answer any more, once it can't.
  let gone: Error | undefined
  const fail = (error: Error) => {
    gone ??= error
    for (const settle of pending.values()) settle(gone)
  }
  child.on("error", (error) => fail(new Error(`Codex's app-server failed: ${error.message}`)))
  // Once its output is all read, so an answer it gave before exiting still counts.
  child.on("close", (code, signal) =>
    fail(new Error(`Codex's app-server exited (${signal ?? `code ${code}`})`)),
  )
  let buffered = ""
  let next = 1
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      try {
        const message = JSON.parse(line) as Message
        if (typeof message.id === "number") pending.get(message.id)?.(message)
      } catch {
        // Not JSON: something else it printed.
      }
    }
  })
  child.stdin.on("error", () => {})
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const request = (method: string, params: object): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (gone) {
        reject(gone)
        return
      }
      const id = next++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex's app-server didn't answer ${method} in ${timeoutMs} ms`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        pending.delete(id)
        if (message instanceof Error) reject(message)
        else if (message.error !== undefined)
          reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`))
        else resolve(message.result)
      })
      send({ jsonrpc: "2.0", id, method, params })
    })
  return {
    start: async () => {
      await request("initialize", { clientInfo: { name: "novadeck-e2e", version: "1" } })
      send({ jsonrpc: "2.0", method: "initialized" })
    },
    request,
    close: () => child.kill(),
  }
}

type Listed = {
  readonly data?: readonly {
    readonly hooks?: readonly {
      readonly key: string
      readonly pluginId?: string | null
      readonly currentHash: string
      readonly trustStatus: string
    }[]
  }[]
}

/**
 * Trusts NovaDeck's hooks in the project as a person does in Codex's "Hooks need review"
 * screen, and lets its MCP tools run without asking, through the same app-server calls
 * that screen makes: `hooks/list` for each hook's current hash, then `config/batchWrite`
 * recording it as trusted. Codex runs a plugin's hooks only once trusted, and NovaDeck
 * counts its prompt only then, asking the same `hooks/list`. Run once NovaDeck's plugin
 * is connected, as the hashes are of the hooks it installed. With `hooks` false only the
 * MCP tools are let run, and the hooks wait for review, as a person who never trusted
 * them leaves them.
 */
export const trustHooks = async (
  sandbox: Sandbox,
  { hooks = true }: { readonly hooks?: boolean } = {},
): Promise<void> => {
  const server = appServer(sandbox.env)
  try {
    await server.start()
    const list = () => server.request("hooks/list", { cwds: [sandbox.project] })
    const listed = (await list()) as Listed
    const ours = (listed.data ?? [])
      .flatMap((entry) => entry.hooks ?? [])
      .filter((hook) => hook.pluginId === "novadeck@novadeck")
    if (ours.length === 0) throw new Error("Codex lists none of NovaDeck's hooks")
    await server.request("config/batchWrite", {
      edits: [
        ...(hooks
          ? [
              {
                keyPath: "hooks.state",
                value: Object.fromEntries(
                  ours.map((hook) => [hook.key, { trusted_hash: hook.currentHash }]),
                ),
                mergeStrategy: "upsert",
              },
            ]
          : []),
        {
          keyPath: "plugins.novadeck@novadeck.mcp_servers.novadeck.default_tools_approval_mode",
          value: "approve",
          mergeStrategy: "upsert",
        },
      ],
    })
    const after = await list()
    if (trustedIn(after) !== hooks)
      throw new Error(
        `Codex ${hooks ? "still doesn't trust" : "trusts"} NovaDeck's hooks: ${JSON.stringify(after)}`,
      )
  } finally {
    server.close()
  }
}

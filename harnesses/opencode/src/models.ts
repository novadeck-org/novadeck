import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

import { rulesOf } from "@novadeck/harness-core/conversation"
import { isFields, parseFields, type Fields } from "@novadeck/harness-core/fields"
import {
  efforts,
  type Choice,
  type Effort,
  type Install,
  type Model,
} from "@novadeck/harness-core/harness"

import { dirs } from "./home.js"

/**
 * A config file's text without its comments and trailing commas (opencode reads `.jsonc` and takes
 * the same in `.json`, config/parse.ts); strings are left whole.
 */
export const stripJsonc = (text: string): string => {
  let out = ""
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (char === '"') {
      let end = index + 1
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1
      out += text.slice(index, end + 1)
      index = end
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      out += "\n"
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2)
      index = end < 0 ? text.length : end + 1
    } else out += char
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

const parse = (text: string): Fields | undefined => parseFields(stripJsonc(text))

const readJson = async (path: string): Promise<Fields | undefined> =>
  parse(await readFile(path, "utf8").catch(() => ""))

const asFields = (value: unknown): Fields => (isFields(value) ? value : {})
const words = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

/** Config merged as opencode merges it: objects deeply, anything else replaced by the later. */
const merge = (into: Fields, from: Fields): Fields => {
  const out: Record<string, unknown> = { ...into }
  for (const [key, value] of Object.entries(from))
    out[key] = isFields(value) && isFields(out[key]) ? merge(out[key] as Fields, value) : value
  return out
}

/**
 * The person's configuration that says which providers and models they have, in the order
 * opencode merges it, later over earlier (config/config.ts:272-274 and 482-489, 1.19.6): the files
 * of its config folder, the file `OPENCODE_CONFIG` names, the folder `OPENCODE_CONFIG_DIR` names, and
 * `OPENCODE_CONFIG_CONTENT`. A project's own `opencode.json` is not read: there is no project here.
 */
const configOf = async (install: Pick<Install, "env" | "home" | "platform">): Promise<Fields> => {
  const rules = rulesOf(install)
  const { config } = dirs(install)
  const {
    OPENCODE_CONFIG: file,
    OPENCODE_CONFIG_DIR: folder,
    OPENCODE_CONFIG_CONTENT: content,
  } = install.env
  const paths = [
    ...["config.json", "opencode.json", "opencode.jsonc"].map((name) => rules.join(config, name)),
    ...(file ? [file] : []),
    ...(folder ? ["opencode.json", "opencode.jsonc"].map((name) => rules.join(folder, name)) : []),
  ]
  const read = await Promise.all(paths.map(readJson))
  const all = read.reduce<Fields>((into, one) => merge(into, one ?? {}), {})
  return content ? merge(all, parse(content) ?? {}) : all
}

/** Words opencode names its reasoning variants by that Novadeck has an effort for. */
const known = (names: Iterable<string>): readonly Effort[] => {
  const set = new Set(names)
  return efforts.filter((effort) => set.has(effort))
}

/**
 * The variants a model's `reasoning_options` make (provider/transform.ts:1717-1745, 1.19.6): an
 * `effort` option's values, a `budget_tokens` option's `high` and `max`, a `toggle`'s `high`; none
 * where it has none or no options. A model with reasoning and no options gets variants from rules by
 * its SDK and id (transform.ts:790-), which are not read here, so it takes none.
 */
const variantsOf = (model: Fields): readonly string[] => {
  if (model.reasoning === false) return []
  const options = Array.isArray(model.reasoning_options)
    ? model.reasoning_options.filter(isFields)
    : []
  const names: string[] = []
  for (const option of options) {
    if (option.type === "effort") names.push(...words(option.values))
    else if (option.type === "budget_tokens") names.push("high", "max")
    else if (option.type === "toggle") names.push("high")
  }
  return names
}

/** What a model's config gives and takes away: `variants` (a `disabled` one is out). */
const configured = (
  model: Fields,
): { readonly add: readonly string[]; readonly drop: readonly string[] } => {
  const variants = asFields(model.variants)
  const names = Object.keys(variants)
  return {
    add: names.filter((name) => !asFields(variants[name]).disabled),
    drop: names.filter((name) => asFields(variants[name]).disabled === true),
  }
}

/** A model id that every shell Novadeck starts passes whole in a command (`kept-flags.ts`' rule). */
const plain = /^[A-Za-z0-9_][A-Za-z0-9_.:@+/-]{0,199}$/

/**
 * The models opencode can start with, from its own files and no command: the catalog it caches
 * (`<cache>/opencode/models.json`, core/src/models-dev.ts:160-163, or the file `OPENCODE_MODELS_PATH`
 * names), for the providers the person can use: a key in `install.env` that the provider's `env`
 * names, a login in `<data>/opencode/auth.json`, a provider in their config, and opencode's own
 * `opencode` provider, whose free models need no key (provider/provider.ts:220-238); less the
 * `disabled_providers`, those outside `enabled_providers`, a provider's `blacklist` and `whitelist`,
 * and the models marked deprecated or alpha (provider.ts:1722-1723). Ids are `provider/model`, as
 * `--model` takes them; the efforts are the variants that share a Novadeck effort's name.
 * None where the catalog is missing, as before opencode ran once. An effort is offered only where
 * Novadeck is connected (its `connected` marker is in `install.plugin`), as only its shim takes
 * the `--variant` word that sets it.
 */
export const readModels = async (install: Install): Promise<readonly Model[]> => {
  const rules = rulesOf(install)
  const { data, cache } = dirs(install)
  const { env } = install
  const linked = await access(join(install.plugin, "connected")).then(
    () => true,
    () => false,
  )
  const catalog = await readJson(env.OPENCODE_MODELS_PATH || rules.join(cache, "models.json"))
  if (!catalog) return []
  const auth = (await readJson(rules.join(data, "auth.json"))) ?? {}
  const config = await configOf(install)
  const own = asFields(config.provider)
  const disabled = new Set(words(config.disabled_providers))
  const enabled = Array.isArray(config.enabled_providers)
    ? new Set(words(config.enabled_providers))
    : undefined

  const found: Model[] = []
  const ids = new Set([...Object.keys(catalog), ...Object.keys(own)])
  for (const id of [...ids].toSorted()) {
    if (disabled.has(id) || (enabled && !enabled.has(id))) continue
    const base = asFields(catalog[id])
    const mine = asFields(own[id])
    const keyed = words(mine.env ?? base.env).some((name) => env[name])
    const usable = keyed || id in auth || id in own
    // opencode's own provider is there for everyone, free models alone without a key.
    const free = id === "opencode" && !(keyed || id in auth || asFields(mine.options).apiKey)
    if (!usable && id !== "opencode") continue
    const models: Record<string, unknown> = { ...asFields(base.models) }
    for (const [name, model] of Object.entries(asFields(mine.models)))
      models[name] = merge(asFields(models[name]), asFields(model))
    const white = Array.isArray(mine.whitelist) ? new Set(words(mine.whitelist)) : undefined
    const black = new Set(words(mine.blacklist))
    for (const [name, value] of Object.entries(models)) {
      const model = asFields(value)
      if (model.status === "deprecated" || model.status === "alpha") continue
      if (black.has(name) || (white && !white.has(name))) continue
      if (free && asFields(model.cost).input !== 0) continue
      const choice = `${id}/${name}`
      if (!plain.test(choice)) continue
      const { add, drop } = configured(model)
      const names = [...variantsOf(model), ...add].filter((word) => !drop.includes(word))
      found.push({ id: choice, efforts: linked ? known(names) : [] })
    }
  }
  return found
}

/**
 * The words that start opencode on `choice`: its `--model` (cli/cmd/tui.ts:120; `-m` too), and, for an
 * effort, Novadeck's own `--variant` word: the TUI has no flag for a variant (`--variant` belongs to
 * `run` alone) and opencode's command line is strict (index.ts:116), so Novadeck's shim strips the
 * word and gives the effort as the variant of its agents (`launchConfig`). Without that shim the word
 * would stop the launch: `readModels` offers an effort only where Novadeck is connected.
 */
export const choose = ({ model, effort }: Choice): readonly string[] => [
  ...(model ? ["--model", model] : []),
  ...(effort ? ["--variant", effort] : []),
]

/** The agents a session starts as, which a launch's effort is set for (`build` is the default). */
const agents = ["build", "plan"]

/**
 * The effort as opencode takes it per launch: the `variant` of its agents, in a configuration the
 * plugin merges over the loaded one (`NOVADECK_OPENCODE_CONFIG`). A session uses an agent's variant
 * only when its model is that agent's own model and the prompt names no variant (session/prompt.ts:
 * 647-654, 1.19.6; the TUI names one only where the person picked it with ctrl+t), so the model goes in
 * the same configuration. Undefined with no model or effort to set.
 */
export const launchConfig = ({ model, effort }: Choice): string | undefined => {
  if (!model || !effort) return undefined
  const agent = { model, variant: effort }
  return JSON.stringify({ agent: Object.fromEntries(agents.map((name) => [name, agent])) })
}

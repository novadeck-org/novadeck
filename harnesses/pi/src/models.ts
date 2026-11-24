import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { fieldsOf } from "@novadeck/harness-core/fields"
import {
  efforts,
  type Choice,
  type Effort,
  type Harness,
  type Model,
} from "@novadeck/harness-core/harness"

/** The file of models Novadeck's extension writes beside itself each time a session starts. */
export const modelsFile = "models.json"

// What a launch's word may hold: a provider and a model id, as pi names them (`openai/gpt-6`).
const plain = /^[A-Za-z0-9_][A-Za-z0-9_.:@+=/-]{0,199}$/

const isEffort = (word: unknown): word is Effort => efforts.includes(word as Effort)

/**
 * The models pi can start with here and the efforts each takes, as Novadeck's extension last
 * wrote them: those whose provider has a key or a sign-in (pi's `modelRegistry.getAvailable()`),
 * each with the thinking levels pi offers it (`getSupportedThinkingLevels`, packages/ai's
 * models.ts, 1.6.0). pi's `off`, `minimal` are levels no other harness has, so they aren't
 * offered as efforts. None before pi ran once in a Novadeck terminal, as nothing else lists them
 * without starting it.
 */
export const parseModels = (text: string): readonly Model[] => {
  let listed: unknown
  try {
    listed = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(listed)) return []
  const found: Model[] = []
  const seen = new Set<string>()
  for (const entry of listed) {
    const fields = fieldsOf(entry)
    const provider = fields?.provider
    const id = fields?.id
    if (typeof provider !== "string" || typeof id !== "string") continue
    const choice = `${provider}/${id}`
    if (!plain.test(choice) || seen.has(choice)) continue
    seen.add(choice)
    const levels = Array.isArray(fields?.levels) ? fields.levels.filter(isEffort) : []
    found.push({ id: choice, efforts: efforts.filter((effort) => levels.includes(effort)) })
  }
  return found
}

/** The models from the extension's file, in the plugin's folder. */
export const readModels: Harness["launch"]["models"] = async (install) =>
  parseModels(await readFile(join(install.plugin, modelsFile), "utf8").catch(() => ""))

/**
 * The words that go right after `pi` to start it with this model and effort: its `--model`, which
 * takes `provider/id`, and its `--thinking`, which pi clamps to what the model takes
 * (docs/cli.md, 1.6.0).
 */
export const choose = ({ model, effort }: Choice): readonly string[] => [
  ...(model === undefined ? [] : ["--model", model]),
  ...(effort === undefined ? [] : ["--thinking", effort]),
]

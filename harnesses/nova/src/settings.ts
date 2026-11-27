import { novaDefaultModelId, novaProvider } from "./model.js"

/** The file of Nova's agent folder pi reads its settings from (its docs' settings.md, 1.6.0). */
export const settingsFile = "settings.json"

/**
 * The settings Nova starts with, which pi reads as the model and thinking level a new session
 * starts on (`defaultProvider`, `defaultModel`, `defaultThinkingLevel`): Nova's default model, so a
 * plain `nova` starts on it with no flag. pi writes this file itself as the person picks another
 * model, and what is there is kept.
 */
export const novaDefaults = {
  defaultProvider: novaProvider,
  defaultModel: novaDefaultModelId,
  defaultThinkingLevel: "medium",
} as const

/**
 * The text of Nova's settings file with `novaDefaults` added where it names no model of its own,
 * from `text`, the file as it is (undefined where there is none); undefined where nothing is to
 * change, or where the file isn't an object pi wrote (it is left as it is). A file that names a
 * provider or a model keeps all of it: the person chose one.
 */
export const seededSettings = (text: string | undefined): string | undefined => {
  let settings: unknown = {}
  if (text !== undefined && text.trim() !== "") {
    try {
      settings = JSON.parse(text)
    } catch {
      return undefined
    }
  }
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return undefined
  const given = settings as Record<string, unknown>
  if ("defaultProvider" in given || "defaultModel" in given) return undefined
  const thinking = "defaultThinkingLevel" in given ? {} : { defaultThinkingLevel: "medium" }
  return `${JSON.stringify(
    {
      ...given,
      defaultProvider: novaDefaults.defaultProvider,
      defaultModel: novaDefaults.defaultModel,
      ...thinking,
    },
    null,
    2,
  )}\n`
}

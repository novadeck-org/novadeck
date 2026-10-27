import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { efforts, type Model } from "@novadeck/harness-core/harness"

const object = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The models Codex lists in its `models_cache.json` (those with `visibility: "list"`), each
 * with the reasoning levels it supports that Novadeck names; none for text it can't read.
 */
export const parseModels = (text: string): readonly Model[] => {
  let cache: unknown
  try {
    cache = JSON.parse(text)
  } catch {
    return []
  }
  if (!object(cache) || !Array.isArray(cache.models)) return []
  const models: Model[] = []
  for (const entry of cache.models as unknown[]) {
    if (!object(entry) || entry.visibility !== "list") continue
    const { slug, supported_reasoning_levels: levels } = entry
    if (typeof slug !== "string" || slug === "") continue
    const supported = new Set(
      (Array.isArray(levels) ? (levels as unknown[]) : []).map((level) =>
        object(level) ? level.effort : undefined,
      ),
    )
    models.push({ id: slug, efforts: efforts.filter((effort) => supported.has(effort)) })
  }
  return models
}

/** The models in the cache Codex keeps in `home`; none where it is missing or unreadable. */
export const readModels = async (home: string): Promise<readonly Model[]> =>
  parseModels(await readFile(join(home, "models_cache.json"), "utf8").catch(() => ""))

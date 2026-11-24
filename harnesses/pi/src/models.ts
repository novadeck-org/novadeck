import type { Choice, Harness, Model } from "@novadeck/harness-core/harness"

/** The words that go right after `pi` to start it with this model and effort. */
export const choose = ({ model, effort }: Choice): readonly string[] => [
  ...(model === undefined ? [] : ["--model", model]),
  ...(effort === undefined ? [] : ["--thinking", effort]),
]

/** The models it can start with: a skeleton, none yet (the extension will write them). */
export const readModels: Harness["launch"]["models"] = (): Promise<readonly Model[]> =>
  Promise.resolve([])

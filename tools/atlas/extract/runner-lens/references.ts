import type { RunnerScan } from "./scan.ts"
import type { Store } from "./store.ts"

// How runner code refers to the store: the receivers that are one, and the store methods a
// body calls through them.

export type StoreReferences = {
  // Whether `receiver` is a store in `file`; `direct` for `this.receiver`, which a name the
  // file also uses for a Map or Set is not.
  isStore: (file: string, receiver: string, direct: boolean) => boolean
  // The store methods a body calls through a store reference of its file, not by name alone.
  callsIn: (body: string, file: string) => string[]
}

// The store's shapes: WorkspaceStore, the types it declares it implements, and object
// types in the runner made only of store methods, at least three of them
// (`VoiceSettingsStore`). An unrelated `FooStore` with its own methods, or a one-method
// lookup that happens to be called `project`, never counts as the store.
const storeTypes = ({ anchors, files }: RunnerScan, store: Store): Set<string> => {
  const names = new Set(store.byName.keys())
  const types = new Set([
    "WorkspaceStore",
    ...(/export class WorkspaceStore implements ([\w\s,]+)\{/.exec(store.source)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  ])
  for (const file of files)
    for (const match of (anchors.read(file) ?? "").matchAll(
      /^export type (\w+) = \{\n([\s\S]*?)^\}/gm,
    )) {
      const members = [...match[2]!.matchAll(/^ {2}(?:readonly\s+)?(\w+)\??\s*[(:<]/gm)].map(
        (member) => member[1]!,
      )
      if (members.length >= 3 && members.every((name) => names.has(name))) types.add(match[1]!)
    }
  return types
}

export const storeReferences = (scan: RunnerScan, store: Store): StoreReferences => {
  const { anchors } = scan
  const typeAlternatives = [...storeTypes(scan, store)].join("|")

  // What a file calls the store: identifiers it declares with one of the store's types
  // (`store: WorkspaceStore`, `records?: TerminalRecords`) or assigns `new WorkspaceStore(`.
  // A name the file also uses for a Map or Set counts only behind another object
  // (`options.records`), never as `this.records`.
  const cache = new Map<string, { names: Set<string>; ambiguous: Set<string> }>()
  const refsIn = (file: string) => {
    const cached = cache.get(file)
    if (cached) return cached
    const text = anchors.read(file) ?? ""
    const names = new Set(
      [
        ...text.matchAll(
          new RegExp(`\\b(\\w+)\\??\\s*:\\s*(?:readonly\\s+)?(?:${typeAlternatives})\\b`, "g"),
        ),
        ...text.matchAll(/\b(\w+)\s*=\s*new WorkspaceStore\(/g),
      ].map((match) => match[1]!),
    )
    const ambiguous = new Set(
      [...names].filter((name) =>
        new RegExp(
          `\\b${name}\\b\\s*(?::[^=\\n]*)?=\\s*new (?:Map|Set)\\b|\\b${name}\\??:\\s*(?:Readonly)?(?:Map|Set)<`,
        ).test(text),
      ),
    )
    const made = { names, ambiguous }
    cache.set(file, made)
    return made
  }
  const isStore = (file: string, receiver: string, direct: boolean): boolean => {
    const { names, ambiguous } = refsIn(file)
    return names.has(receiver) && !(direct && ambiguous.has(receiver))
  }

  const callsIn = (body: string, file: string): string[] => [
    ...new Set(
      [...body.matchAll(/\b(\w+)\??\.(\w+)\(/g)]
        .filter(
          (match) =>
            store.byName.has(match[2]!) &&
            isStore(
              file,
              match[1]!,
              body.slice(Math.max(0, match.index - 5), match.index) === "this.",
            ),
        )
        .map((match) => match[2]!),
    ),
  ]
  return { isStore, callsIn }
}

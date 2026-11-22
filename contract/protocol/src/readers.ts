import { getEventIteratorSchemaDetails } from "@orpc/contract"

import { contract } from "./contract.js"
import { isDropped, readerOf } from "./open.js"

type Read = (value: unknown) => unknown

// Each procedure's reader by its dotted path, where its answer, or its stream's items, have
// open parts; made once, on first use.
let readers: ReadonlyMap<string, Read> | undefined

const made = (): ReadonlyMap<string, Read> => {
  const found = new Map<string, Read>()
  const walk = (node: unknown, path: readonly string[]): void => {
    if (typeof node !== "object" || node === null) return
    if ("~orpc" in node) {
      const { outputSchema } = (node as { readonly "~orpc": { readonly outputSchema?: unknown } })[
        "~orpc"
      ]
      const stream = getEventIteratorSchemaDetails(outputSchema as never)
      const read = readerOf(stream ? stream.yields : outputSchema)
      if (read) found.set(path.join("."), read)
      return
    }
    for (const [key, inner] of Object.entries(node)) walk(inner, [...path, key])
  }
  walk(contract, [])
  return found
}

/**
 * How a UI reads what a runner answers, as the wire's client takes it (`outputs`): each
 * procedure's open parts read tolerantly (open.ts), and a stream's items read as dropped left
 * out. A procedure with none is read as it comes.
 */
export const answerReaders = {
  reader: (path: readonly string[]): Read | undefined => (readers ??= made()).get(path.join(".")),
  skips: isDropped,
}

import { createKept, type Kept } from "@novadeck/viewers"
import { useEffect, useRef, useState } from "react"

// What a backend answered about a change, kept by the question (the item, layers and path: its
// `family`) and the stamp the change had when it was asked, so the same question asked again
// as the person steps back and forth is not put again. One entry to a family: an answer at a
// newer stamp replaces the older, which stands in the meantime (`useAnswer`), so a change read
// again does not blank what is shown. Each item store of a session has its own, of at most
// `limit` families, which a session that goes takes with it. A failure is not kept.

type Entry<Value> = { readonly stamp: string; readonly value: Value; readonly at: number }

export type Answers<Value> = {
  /** The answer at this stamp, if it is known. */
  readonly peek: (family: string, stamp: string) => Value | undefined
  /** The latest answer to the family, whatever its stamp. */
  readonly latest: (family: string) => Value | undefined
  /** The answer at this stamp, from what is kept, from a run already asking, or by `read`. */
  readonly load: (family: string, stamp: string, read: () => Promise<Value>) => Promise<Value>
}

const make = <Value>(limit: number): Answers<Value> => {
  const kept: Kept<Entry<Value>> = createKept<Entry<Value>>(limit)
  const asked = new Map<string, Promise<Value>>()
  let asks = 0
  return {
    peek: (family, stamp) => {
      const known = kept.get(family)
      return known?.stamp === stamp ? known.value : undefined
    },
    latest: (family) => kept.get(family)?.value,
    load: (family, stamp, read) => {
      const known = kept.get(family)
      if (known?.stamp === stamp) return Promise.resolve(known.value)
      const key = `${family}\0${stamp}`
      const pending = asked.get(key)
      if (pending) return pending
      asks += 1
      const at = asks
      const loading = read()
        .then((value) => {
          // An answer to a later question stays, whichever of the two comes in last.
          if ((kept.get(family)?.at ?? 0) <= at) kept.keep(family, { stamp, value, at })
          return value
        })
        .finally(() => asked.delete(key))
      asked.set(key, loading)
      return loading
    },
  }
}

/** The answers of a kind, by item store. */
export const answersIn = <Value>(limit: number): ((scope: object) => Answers<Value>) => {
  const all = new WeakMap<object, Answers<Value>>()
  return (scope) => {
    const known = all.get(scope)
    if (known) return known
    const made = make<Value>(limit)
    all.set(scope, made)
    return made
  }
}

/**
 * The answer to a family at a stamp, read once by `read` when `family` is given: the value
 * (the latest known one while the stamp's is read) and whether the read failed with nothing
 * to show instead.
 */
export const useAnswer = <Value>(
  answers: Answers<Value>,
  family: string | null,
  stamp: string,
  read: () => Promise<Value>,
): { readonly value: Value | undefined; readonly failed: boolean } => {
  const [, setTick] = useState(0)
  const [failedAt, setFailedAt] = useState<string | null>(null)
  const asking = useRef(read)
  useEffect(() => {
    asking.current = read
  })
  const fresh = family === null ? undefined : answers.peek(family, stamp)
  const key = `${family}\0${stamp}`
  useEffect(() => {
    if (family === null || answers.peek(family, stamp) !== undefined) return
    let live = true
    answers
      .load(family, stamp, () => asking.current())
      .then(
        () => live && setTick((now) => now + 1),
        () => live && setFailedAt(`${family}\0${stamp}`),
      )
    return () => {
      live = false
    }
  }, [answers, family, stamp])
  const value = family === null ? undefined : (fresh ?? answers.latest(family))
  return { value, failed: value === undefined && failedAt === key }
}

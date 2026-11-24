import { classify, type Shape, type ShapeLists } from "@novadeck/harness-core/shapes"

/** The shapes of pi's session records the decoder reads, and those it skips knowingly. A skeleton. */
export const lists: ShapeLists = { read: [], skipped: [] }

const verdicts = classify(lists)

/** Whether a shape is inside the conversation. */
export const conversational = (_key: string): boolean => false

/** The shapes one line of the transcript holds. */
export const shapes = (_line: string): readonly Shape[] => verdicts([])

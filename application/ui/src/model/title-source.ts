import { MURMUR_NAME } from "./murmur"
import type { TitleSource } from "./types"

// Whether two say the name is from the same one.
export const sameTitleSource = (a: TitleSource | undefined, b: TitleSource | undefined): boolean =>
  a?.kind === b?.kind && (a?.kind !== "agent" || (b?.kind === "agent" && a.by === b.by))

// Who a terminal's name is from, as its tab's tooltip says it.
export const titleSourceText = (source: TitleSource): string => {
  switch (source.kind) {
    case "person":
      return "Named by you"
    case "agent":
      return `Named by the agent in ${source.by}`
    case "murmur":
      return `Named by ${MURMUR_NAME}`
    case "default":
      return "Default name"
  }
}

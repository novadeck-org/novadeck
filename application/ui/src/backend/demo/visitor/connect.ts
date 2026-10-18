import type { BackendConnection, ThemeSource } from "#core/port"

import { visitorDemo } from "./index"

// The visitor build's start: a connection that always succeeds, with nothing to reach. Its
// terminals draw in the page's theme, which the entry hands over.
export const connectVisitor = async (
  _signal: AbortSignal,
  progress: (stage: "loading") => void,
  { theme }: { readonly theme: ThemeSource },
): Promise<BackendConnection> => {
  progress("loading")
  return { createBackend: () => visitorDemo({ theme }), close: () => {} }
}

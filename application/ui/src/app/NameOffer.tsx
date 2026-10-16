import { useEffect } from "react"

import { useWorkspaceServices } from "./controller/context"
import { offerable } from "./murmur-offer"
import { currentContext, currentState } from "./selectors"

// A backend that asks to offer Murmur now (the demo's debug panel) puts the chip on the
// selected terminal, whatever came before. The offer on a finished turn is `nameFinished`
// (murmur-offer.ts), wired where finishes are watched. Nothing is drawn here.
export const NameOffer = (): null => {
  const { backend, workspace, commands } = useWorkspaceServices()
  const { murmur } = backend
  useEffect(() => {
    const requests = murmur?.offer
    if (!murmur || !requests) return undefined
    let seen = requests.getSnapshot()
    return requests.subscribe(() => {
      const count = requests.getSnapshot()
      if (count === seen) return
      seen = count
      const snapshot = workspace.getSnapshot()
      const { selected } = currentState(snapshot)
      if (!selected || !offerable(murmur.state.getSnapshot())) return
      commands.offerNameTo({ context: currentContext(snapshot), id: selected })
    })
  }, [murmur, workspace, commands])
  return null
}

import { useEffect } from "react"

import type { BootProgress } from "../backend/port"
import { useWorkspaceServices } from "./controller/context"

const ready: BootProgress = { attached: 0, total: 0, done: true }

// Tells the boot splash how far the backend is from attaching the restored terminals;
// a backend that reports nothing is ready at once. Renders nothing.
export const BootReporter = ({
  report,
}: {
  readonly report: (progress: BootProgress) => void
}): null => {
  const { backend } = useWorkspaceServices()
  useEffect(() => {
    const { boot } = backend
    if (!boot) return report(ready)
    report(boot.getSnapshot())
    return boot.subscribe(() => report(boot.getSnapshot()))
  }, [backend, report])
  return null
}

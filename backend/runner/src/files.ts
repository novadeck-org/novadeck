// File-system checks the runner's domains share.
import { access } from "node:fs/promises"

/** Whether a path exists. */
export const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

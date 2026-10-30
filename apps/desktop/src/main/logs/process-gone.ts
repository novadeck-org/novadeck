// What the app logs of a process that ended other than as asked.

import type { Data } from "@novadeck/log"

/** What `child-process-gone` says of a process, as a line's data. */
export const goneData = (details: {
  readonly type: string
  readonly reason: string
  readonly exitCode: number
  readonly serviceName?: string
  readonly name?: string
}): Data => ({
  type: details.type,
  reason: details.reason,
  exitCode: details.exitCode,
  ...(details.serviceName !== undefined && { service: details.serviceName }),
  ...(details.name !== undefined && { name: details.name }),
})

/**
 * Whether a process ended other than cleanly. A kill counts: the system's OOM killer and a
 * person's `kill -9` both end the runner so, and a kill the app asks for is a slow close's.
 */
export const goneBadly = (reason: string): boolean => reason !== "clean-exit"

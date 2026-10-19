import { timingSafeEqual } from "node:crypto"

import type { Record } from "./record.js"

/** Whether two tokens are the same, in time that doesn't tell how much of them matched. */
export const sameToken = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/**
 * The record of the terminal a call came from, when it still runs there and the call
 * carries its shell's own token; a call without it learns nothing more.
 */
export const callerOf = <R extends Pick<Record, "terminal" | "token">>(
  records: ReadonlyMap<string, R>,
  call: { readonly terminalId: string; readonly token: string },
): R | undefined => {
  const record = records.get(call.terminalId)
  return !record || record.terminal.exiting || !sameToken(record.token, call.token)
    ? undefined
    : record
}

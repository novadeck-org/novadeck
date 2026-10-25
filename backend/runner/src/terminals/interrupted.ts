import { tailLines } from "@novadeck/harness-core/follow"

import { busy } from "./busy.js"
import type { Record } from "./record.js"

/**
 * What a resumed agent is told when the stop of Novadeck, as for an update, cut its turn
 * short, worded as Novadeck's automatic notice.
 */
export const interruptedNotice =
  "Novadeck: automatic notice, not from the user: Novadeck restarted (for an update, or " +
  "because it was closed) while your last turn was running, and has resumed this session. " +
  "Carry on where you left off; if that work is already done, say so in a line. This " +
  "notice needs no other reply."

/**
 * The notice a resumed terminal's agent is due, or undefined: only for the first root
 * session to bind in a terminal whose shell resumed an agent, whose harness's transcript
 * says its last turn was cut short (`Harness["transcripts"].cutShort`), and only if
 * nothing has started a turn there since (the person's own words carry the agent on). An
 * agent that was idle, waiting on the person or ended by an error is never told, and nor
 * is one whose harness cannot say; a session that was not resumed has no cut turn. The
 * terminal is marked (`resumeTold`), so this decides once.
 */
export const interruptedFor = async (
  record: Pick<Record, "resumeClaim" | "resumeTold" | "root" | "transcript" | "bound">,
  cutShort: ((lines: readonly string[]) => boolean) | undefined,
  read: (path: string) => Promise<readonly string[] | undefined> = tailLines,
): Promise<string | undefined> => {
  const { root, transcript } = record
  if (!record.resumeClaim || record.resumeTold || !root || !transcript || !cutShort)
    return undefined
  // Once per resume: the first root session it follows, whatever it turns out to be.
  record.resumeTold = true
  if (!record.resumeClaim.startsWith(`${root.agent}:`)) return undefined
  const lines = await read(transcript)
  if (!lines || !cutShort(lines)) return undefined
  // A turn started meanwhile, as the person typed, goes on by itself.
  if (record.root !== root || busy(record.bound?.activity)) return undefined
  return interruptedNotice
}

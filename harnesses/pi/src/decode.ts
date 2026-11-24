import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"

/**
 * pi's reports, as normalized facts: what Novadeck's extension tells the relay, under the event
 * names plugin.ts lists. A skeleton: nothing is read yet.
 */
export const decode = (_report: Report): readonly HarnessEvent[] => []

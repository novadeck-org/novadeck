// The agent harnesses' data table, as the protocol keeps it: the one place model/ reads
// the wire package, through its data-only entry, so the entry point loads no schemas.
export { harnesses } from "@novadeck/protocol/harnesses"
export type { HarnessId as AgentName } from "@novadeck/protocol/harnesses"

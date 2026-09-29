import { agentSessionId, type AgentName } from "@novadeck/protocol"

import { harnesses } from "./registry.js"

/**
 * The command that resumes `agent`'s session, as plain words a shell runs as they are;
 * undefined for a session id that is not a plain token, or a harness that cannot resume.
 * Without a session there is nothing to resume: an agent never starts with "continue
 * the last one".
 */
export const resumeCommand = (agent: AgentName, session: string): readonly string[] | undefined =>
  agentSessionId.safeParse(session).success ? harnesses[agent].resume?.(session) : undefined

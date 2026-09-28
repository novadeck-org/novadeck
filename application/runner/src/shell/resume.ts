import { agentSessionId, type AgentName } from "@novadeck/protocol"

// The plain command that continues each agent's session by its id. Without a session
// there is nothing to resume: an agent never starts with "continue the last one".
const resumers: Record<AgentName, (session: string) => readonly string[]> = {
  claude: (session) => ["claude", "--resume", session],
  codex: (session) => ["codex", "resume", session],
  agy: (session) => ["agy", "--conversation", session],
}

/**
 * The command that resumes `agent`'s session, as plain words a shell runs as they are;
 * undefined for a session id that is not a plain token.
 */
export const resumeCommand = (agent: AgentName, session: string): readonly string[] | undefined =>
  agentSessionId.safeParse(session).success ? resumers[agent](session) : undefined

import { agentName, type AgentName } from "@novadeck/protocol"

// The agent a fresh shell resumes in place of `program`, a name from core's `programName`:
// any agent the runner integrates, by the same name. The runner decides whether it can
// resume, and resumes only the session the agent last reported there.
export const resumableProgram = (program: string | undefined): AgentName | undefined => {
  const parsed = agentName.safeParse(program)
  return parsed.success ? parsed.data : undefined
}

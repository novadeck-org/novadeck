import { agentName, type AgentName } from "@novadeck/protocol"

// Programs NovaDeck resumes in a fresh shell: the agents the runner integrates, by the
// same names. The runner decides whether each one can resume, and resumes only the
// session the agent last reported there.
export type ResumableProgram = AgentName

// Takes a name from `programName`.
export const resumableProgram = (program: string | undefined): ResumableProgram | undefined => {
  const parsed = agentName.safeParse(program)
  return parsed.success ? parsed.data : undefined
}

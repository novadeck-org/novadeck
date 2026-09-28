// Programs NovaDeck resumes in a fresh shell: the agents whose sessions it can identify.
// The runner resumes the session the agent last reported there, and only that one.
const resumable = ["claude", "codex", "agy"] as const

export type ResumableProgram = (typeof resumable)[number]

// Takes a name from `programName`.
export const resumableProgram = (program: string | undefined): ResumableProgram | undefined =>
  resumable.find((name) => name === program)

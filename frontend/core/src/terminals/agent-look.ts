import { harnesses } from "../harnesses"

// How a terminal's agent is called, in one place. Nova, is the agent `pi` to
// the runner, which tells the UI so (`nova`): the UI calls it Nova and draws Novadeck's mark. The
// person's own pi stays Pi.

export const novaName = "Nova"

// Whether the agent is Nova: only a pi can be, and only where the runner says so.
export const isNova = (agent: string | null | undefined, nova: boolean | undefined): boolean =>
  agent === "pi" && nova === true

// The agent as a person calls it: the harness's name (`name`, or the `shortName` a sentence
// takes), Nova's where it is; undefined for a program no harness names.
export const agentNamed = (
  agent: string | null | undefined,
  nova: boolean | undefined,
  form: "name" | "shortName" = "shortName",
): string | undefined =>
  isNova(agent, nova) ? novaName : harnesses.find(({ id }) => id === agent)?.[form]

// The program as its terminal runs it, the word a peer's line shows: `nova` for Nova.
export const programWord = (program: string, nova: boolean | undefined): string =>
  isNova(program, nova) ? "nova" : program

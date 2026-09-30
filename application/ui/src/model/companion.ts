// What an agent puts in front of the user beside its terminal: the plan it wrote, and
// images, project files and preview-browser pages it shows. A backend reports them; the
// terminal's companion pane presents them. Design study: only the content-preview demo
// implements this so far, and a runner would report the same from the agent's files.

// An image the agent showed, by a URL the page can load.
export type ImageArtifact = {
  readonly id: string
  readonly kind: "image"
  readonly name: string
  readonly detail: string
  readonly src: string
}

// A file from the project, with the lines the agent pointed at.
export type FileArtifact = {
  readonly id: string
  readonly kind: "file"
  readonly name: string
  readonly detail: string
  readonly path: string
  // The number of the first line in `lines`.
  readonly firstLine: number
  readonly lines: readonly string[]
  readonly from: number
  readonly to: number
}

// A page the agent opened in the preview browser. Until the pane hosts a browser, it
// shows the page as a snapshot image.
export type PageArtifact = {
  readonly id: string
  readonly kind: "page"
  readonly name: string
  readonly detail: string
  readonly url: string
  readonly snapshot: string
}

export type Artifact = ImageArtifact | FileArtifact | PageArtifact

export type ArtifactKind = Artifact["kind"]

// The plan file an agent wrote, as it stood when the terminal came up.
export type AgentPlan = {
  readonly path: string
  readonly agent: string
  // Whether NovaDeck's skill is installed for this agent. It tells the agent to re-read
  // the plan before acting on it, apply the notes left in it, and remove each one.
  readonly skill: boolean
  readonly text: string
}

export type CompanionSeed = {
  readonly plan: AgentPlan
  // What the agent had already shown, oldest first.
  readonly shown: readonly Artifact[]
}

export type CompanionEvent =
  // The agent wrote its plan again. `appliedNotes`: it read the notes left in the file
  // and applied them, so they go. The demo agent can't write the file itself, so it
  // says so instead of removing them.
  | {
      readonly type: "plan/revised"
      readonly terminalId: string
      readonly text: string
      readonly appliedNotes: boolean
    }
  // The agent showed something. `asked`: the user asked for it, so it opens.
  | {
      readonly type: "artifact/shown"
      readonly terminalId: string
      readonly artifact: Artifact
      readonly asked: boolean
    }

export type Companions = {
  // The terminals whose agent has a plan, by terminal ID.
  readonly terminals: Readonly<Record<string, CompanionSeed>>
  readonly subscribe: (listener: (event: CompanionEvent) => void) => () => void
  // The plan file as the user left it: their edits and notes, for the agent to read.
  readonly save: (terminalId: string, text: string) => void
}

// A note as NovaDeck writes it into the plan: an HTML comment, invisible once rendered,
// marked for the agent's skill to find.
export const noteOpen = "<!-- novadeck: "
export const noteClose = " -->"

export const notePattern = /<!-- novadeck: (.*?) -->/g

export const notesIn = (text: string): number => [...text.matchAll(notePattern)].length

// A note's text as the comment around it allows: one line, and no `-->`, which would
// end the comment early and spill the rest of the note into the plan.
export const noteSafe = (text: string): string => {
  let safe = text.replace(/\s*\n\s*/g, " ")
  while (safe.includes("-->")) safe = safe.replaceAll("-->", "->")
  return safe
}

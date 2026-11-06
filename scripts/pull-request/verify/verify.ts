const titleTypes = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "poc",
  "refactor",
  "revert",
  "style",
  "test",
])

export type Verification = {
  descriptionErrors: string[]
  titleErrors: string[]
}

const descriptionSections = ["What", "Why", "Impact", "Heads-up"]

export const requiredSections = (author: string): string[] =>
  author === "dependabot[bot]" ? [] : descriptionSections

export const verifyTitle = (title: string): string[] => {
  const header = /^([\w-]+)(?:\((.*)\))?(!)?:\s*(.+)$/.exec(title)

  return !header || !titleTypes.has(header[1] ?? "")
    ? ["Use type(optional-scope): concise imperative summary."]
    : []
}

// A Heads-up left as the template has it asks nothing of anyone, which is what requiring the
// section is there to stop: it has to say something, if only None.
const unanswered = (body: string): boolean => {
  const found = /^##\s+Heads-up\s*$(?<text>[\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)
  return found !== null && found.groups!.text!.replace(/<!--[\s\S]*?-->/g, "").trim() === ""
}

export const verifyDescription = (body: string, sections: string[]): string[] => {
  const missing = sections
    .filter((section) => !new RegExp(`^##\\s+${section}\\s*$`, "m").test(body))
    .map((section) => `Add a ## ${section} heading.`)
  return sections.includes("Heads-up") && unanswered(body)
    ? [...missing, "Say what works differently under ## Heads-up, or write None."]
    : missing
}

export const verifyPullRequest = (
  title: string,
  body: string,
  sections = descriptionSections,
): Verification => {
  return {
    descriptionErrors: verifyDescription(body, sections),
    titleErrors: verifyTitle(title),
  }
}

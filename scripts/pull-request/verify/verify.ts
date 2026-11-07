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

const descriptionSections = ["What", "Why", "Impact"]

export const requiredSections = (author: string): string[] =>
  author === "dependabot[bot]" ? [] : descriptionSections

export const verifyTitle = (title: string): string[] => {
  const header = /^([\w-]+)(?:\((.*)\))?(!)?:\s*(.+)$/.exec(title)

  return !header || !titleTypes.has(header[1] ?? "")
    ? ["Use type(optional-scope): concise imperative summary."]
    : []
}

export const verifyDescription = (body: string, sections: string[]): string[] => {
  return sections
    .filter((section) => !new RegExp(`^##\\s+${section}\\s*$`, "m").test(body))
    .map((section) => `Add a ## ${section} heading.`)
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

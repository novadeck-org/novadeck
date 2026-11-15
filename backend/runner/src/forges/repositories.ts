import type { RepositoryFacts } from "./service.js"

/** The works' repositories, each with the branches their checkouts are on. */
export const repositoriesOf = (
  works: readonly { readonly commonDir: string; readonly branch: string }[],
  fetchedAt: (commonDir: string) => number | undefined,
): RepositoryFacts[] => {
  const branches = new Map<string, Set<string>>()
  for (const { commonDir, branch } of works) {
    const set = branches.get(commonDir) ?? new Set<string>()
    if (branch !== "") set.add(branch)
    branches.set(commonDir, set)
  }
  return [...branches].map(([commonDir, set]) => ({
    commonDir,
    branches: [...set],
    fetchedAt: fetchedAt(commonDir),
  }))
}

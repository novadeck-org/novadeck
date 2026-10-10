/**
 * What a terminal knows of the words likely said into it, as `Terminals.hintFacts` reads
 * them: its project's name, its folder, its git branch, the folders its agent writes in
 * most, as paths inside the project, and the names of the files shown beside it and
 * written last.
 */
export type HintFacts = {
  readonly project: string | null
  readonly cwd: string
  readonly branch: string | null
  readonly folders: readonly string[]
  readonly files: readonly string[]
}

/**
 * How many module names a hint lists after its project, branch and folder: the parts of
 * the paths written in, as a monorepo's packages and their modules.
 */
export const hintModules = 6
/** How many file names it lists after them. */
export const hintFiles = 8
/**
 * The longest hint, in characters: a sentence or two, well inside the 224 tokens Whisper
 * reads of a prompt, since a long one gets copied into the transcript, or makes it up.
 */
export const hintChars = 200
/** The longest project name a hint gives, which leaves room in it for the rest. */
const projectChars = 64

// Folder and branch names that say nothing of what the work is about, as the folders a
// monorepo keeps its packages in.
const generic = new Set([
  "src",
  "packages",
  "apps",
  "application",
  "applications",
  "libs",
  "modules",
  "internal",
  "pkg",
  "cmd",
  "lib",
  "dist",
  "build",
  "out",
  "bin",
  "node_modules",
  "test",
  "tests",
  "tmp",
  "main",
  "master",
  "trunk",
  "develop",
  "head",
])

const lastSegment = (path: string): string =>
  path
    .split(/[\\/]/)
    .findLast((part) => part.trim())
    ?.trim() ?? ""

/**
 * Whether a name would only mislead the engine: too short or long to be said, a commit or
 * an id rather than a word, a number, an address, or a folder every project has.
 */
const noise = (name: string): boolean => {
  const characters = [...name]
  if (characters.length < 2 || characters.length > 32) return true
  // A word of the letters a to f alone, as "defaced", is a word, not a commit.
  if (/^(?=.*\d)[0-9a-f]{7,}$/i.test(name) || /[0-9a-f]{8}-[0-9a-f]{4}/i.test(name)) return true
  const letters = characters.filter((each) => /\p{L}/u.test(each)).length
  if (letters === 0 || characters.filter((each) => /\d/.test(each)).length > letters) return true
  return /[@:]/.test(name) || generic.has(name.toLowerCase())
}

const listed = (names: readonly string[]): string =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(", ")

/**
 * The prompt that helps the engine spell what is said in a terminal: its project, branch
 * and folder, then the modules and files it works on, each once, without noise, cut to
 * `hintModules`, `hintFiles` and `hintChars`. Whisper writes in its prompt's style, so
 * they make a sentence, capitalised and punctuated: a bare list of names gets back
 * lowercase text without punctuation. Its words are English only where the person speaks
 * English (`language`), as the prompt would otherwise pull the transcript towards
 * English; for any other language, or `auto`, the names stand alone.
 */
export const dictationHint = (facts: HintFacts, language: string): string => {
  const english = language === "en"
  // Names already given, as a file's name without its extension, which says it as well,
  // whichever of them comes first.
  const seen = new Set<string>()
  const fresh = (name: string | null): string | null => {
    const key = name
      ?.trim()
      .toLowerCase()
      .replace(/\.\p{L}{1,5}$/u, "")
    if (!name || !key || seen.has(key)) return null
    seen.add(key)
    return name.trim()
  }
  const projectName = facts.project?.trim() ?? ""
  const project = [...projectName].length > projectChars ? null : fresh(projectName || null)
  const branchName = facts.branch === null ? "" : lastSegment(facts.branch)
  const branch = noise(branchName) ? null : fresh(branchName)
  const folderName = lastSegment(facts.cwd)
  const folder = noise(folderName) ? null : fresh(folderName)
  const pick = (candidates: readonly string[], count: number): string[] => {
    const names: string[] = []
    for (const candidate of candidates) {
      if (names.length === count) break
      const name = noise(candidate) ? null : fresh(candidate)
      if (name) names.push(name)
    }
    return names
  }
  // Each folder's parts from the project down, as its package before its module; none of
  // one in a hidden folder, which holds tools' files, as `.github` or `.config` does.
  const parts = facts.folders.flatMap((path) => {
    const each = path.split(/[\\/]/).map((part) => part.trim())
    return each.some((part) => part.startsWith(".")) ? [] : each
  })
  const listing = [...pick(parts, hintModules), ...pick(facts.files, hintFiles)]
  const compose = (names: readonly string[]): string => {
    if (!english) {
      const head = [project, branch, folder].filter((part) => part !== null).join(", ")
      if (!names.length) return head ? `${head}.` : ""
      return head ? `${head}: ${names.join(", ")}.` : `${names.join(", ")}.`
    }
    const clauses = [
      project && `Working on ${project}`,
      branch && `on the ${branch} branch`,
      folder && `in the ${folder} folder`,
      names.length ? `with ${listed(names)}` : null,
    ].filter((clause) => clause !== null)
    // Without a project, the sentence starts at its next clause.
    const text = clauses.join(", ")
    return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : ""
  }
  let kept = listing
  while (kept.length && compose(kept).length > hintChars) kept = kept.slice(0, -1)
  return compose(kept)
}

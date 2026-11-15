import { azure } from "./azure.js"
import type { Forge, ForgeName, Remote, Repository } from "./forge.js"
import { github } from "./github.js"
import { gitlab } from "./gitlab.js"

/** Every forge, by name. */
export const forges: Readonly<Record<ForgeName, Forge>> = { github, gitlab, azure }

/**
 * The forge and repository a remote names, among the forges given (all where none are): the
 * first forge that claims it, with `signedIn` the hosts each forge's tool is signed in to (a
 * host no forge is known by is claimed only by a forge signed in there).
 */
export const repositoryOf = (
  remote: Remote,
  signedIn: Partial<Readonly<Record<ForgeName, readonly string[]>>> = {},
  among: readonly ForgeName[] = ["github", "gitlab", "azure"],
): Repository | undefined => {
  // Hosts a forge is known by first, so a self-managed host goes to the forge signed in there.
  for (const known of [false, true]) {
    for (const name of among) {
      const found = forges[name].repository(remote, known ? (signedIn[name] ?? []) : [])
      if (found !== undefined) return found
    }
  }
  return undefined
}

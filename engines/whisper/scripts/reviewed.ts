import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"

/** The id git gives a file's contents (`git hash-object`): what a patch's `index` line names. */
export const blobId = (data: Uint8Array): string =>
  createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex")

/**
 * The one file a patch changes, and the abbreviated id of the file it leaves, from the
 * `index <before>..<after>` line `git diff` writes.
 */
export const patchedFile = (patch: string): { readonly path: string; readonly after: string } => {
  const files = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)]
  const index = /^index [0-9a-f]{7,40}\.\.([0-9a-f]{7,40})(?: \d+)?$/m.exec(patch)
  const path = files[0]?.[1]
  if (files.length !== 1 || path === undefined || index?.[1] === undefined) {
    throw new Error("The patch must change one file and keep the index line `git diff` writes.")
  }
  return { path, after: index[1] }
}

/**
 * Fails unless the file `patch` changes in `source` is, once patched, the very file it was cut
 * and reviewed against, as the patch's own `index` line names it. A patch whose context still
 * matches an upstream file that changed elsewhere applies cleanly, so this is what stops a
 * source bump from shipping a patch nobody re-checked. `review` says what to re-check.
 */
export const requireReviewedFile = async (
  source: string,
  patch: string,
  review: string,
): Promise<void> => {
  const { path, after } = patchedFile(await readFile(patch, "utf8"))
  // Compared as git stores it, with LF line endings, as a Windows git configured to write
  // CRLF may have left it.
  const text = (await readFile(join(source, path), "utf8")).replaceAll("\r\n", "\n")
  const found = blobId(new TextEncoder().encode(text))
  if (!found.startsWith(after)) {
    throw new Error(
      `${path} is not the file ${basename(patch)} was reviewed against (${after}, found ${found.slice(0, after.length)}). ${review}`,
    )
  }
}

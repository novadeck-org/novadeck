// What a release's `latest.yml` (electron-builder's update file) lists: its version, and
// each file's hash and size.
import { updateVersionPattern } from "@novadeck/protocol/bridge"

// The value of the top-level or listed `key:` on a line of latest.yml, unquoted.
const yamlValue = (line: string, key: string): string | undefined => {
  const match = new RegExp(`^\\s*(?:-\\s+)?${key}:[ \\t]*(.*?)[ \\t]*$`, "u").exec(line)
  return match?.[1]?.replace(/^(["'])(.*)\1$/u, "$2")
}

/** The release `version` that `latest.yml` names, if it names a plausible one. */
export const latestVersionOf = (yaml: string): string | undefined => {
  for (const line of yaml.split(/\r?\n/u)) {
    if (/^\s/u.test(line)) continue
    const version = yamlValue(line, "version")
    if (version !== undefined) return updateVersionPattern.test(version) ? version : undefined
  }
  return undefined
}

/**
 * The `sha512` (base64) that `latest.yml` lists for the file `name`: its `files` entry, or
 * the top-level `path` and `sha512` electron-builder repeats from the first. Undefined if
 * the file is not listed or has no hash.
 */
export const sha512Of = (yaml: string, name: string): string | undefined => {
  let url: string | undefined
  let hash: string | undefined
  const entries: { url: string | undefined; hash: string | undefined }[] = []
  let top: { path: string | undefined; hash: string | undefined } = {
    path: undefined,
    hash: undefined,
  }
  for (const line of yaml.split(/\r?\n/u)) {
    if (/^\s*-\s/u.test(line)) {
      if (url !== undefined || hash !== undefined) entries.push({ url, hash })
      url = undefined
      hash = undefined
    }
    if (/^\s/u.test(line)) {
      url = yamlValue(line, "url") ?? url
      hash = yamlValue(line, "sha512") ?? hash
    } else {
      top = {
        path: yamlValue(line, "path") ?? top.path,
        hash: yamlValue(line, "sha512") ?? top.hash,
      }
    }
  }
  if (url !== undefined || hash !== undefined) entries.push({ url, hash })
  const listed = entries.find((entry) => entry.url === name)
  if (listed) return listed.hash || undefined
  return top.path === name ? top.hash || undefined : undefined
}

/**
 * The `size` in bytes that `latest.yml` lists for the file `name` in its `files` entries,
 * or undefined if there is none or it is not a positive whole number.
 */
export const sizeOf = (yaml: string, name: string): number | undefined => {
  let url: string | undefined
  let size: string | undefined
  const entries: { url: string | undefined; size: string | undefined }[] = []
  for (const line of yaml.split(/\r?\n/u)) {
    if (/^\s*-\s/u.test(line)) {
      if (url !== undefined || size !== undefined) entries.push({ url, size })
      url = undefined
      size = undefined
    }
    if (/^\s/u.test(line)) {
      url = yamlValue(line, "url") ?? url
      size = yamlValue(line, "size") ?? size
    }
  }
  if (url !== undefined || size !== undefined) entries.push({ url, size })
  const listed = entries.find((entry) => entry.url === name)?.size
  const bytes = listed !== undefined && /^\d{1,12}$/u.test(listed) ? Number(listed) : undefined
  return bytes !== undefined && bytes > 0 ? bytes : undefined
}

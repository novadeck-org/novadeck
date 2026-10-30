type Part = { readonly offset: number; readonly data: string }

/**
 * Bytes as base64 parts of at most `length` characters, each with the byte `offset` it starts
 * at: whole groups of three bytes, so no part but the last is padded.
 */
export const base64Parts = (data: Uint8Array, length: number): Part[] => {
  const size = (length / 4) * 3
  const parts: Part[] = []
  for (let offset = 0; offset < data.length; offset += size) {
    const part = data.subarray(offset, offset + size)
    let binary = ""
    for (let at = 0; at < part.length; at += 8192)
      binary += String.fromCharCode(...part.subarray(at, at + 8192))
    parts.push({ offset, data: btoa(binary) })
  }
  return parts
}

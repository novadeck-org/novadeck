// The id a URL hash names. A malformed %-escape reads as the raw text, never throws.
export const hashId = (hash: string) => {
  const raw = hash.slice(1)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
export const areaPath = (id: string) => `/areas/${id}`
export const procedurePath = (id: string) => `/api#${encodeURIComponent(id)}`
export const tablePath = (name: string) => `/data#${encodeURIComponent(`table:${name}`)}`
export const settingId = (group: string, key: string) => `setting:${group}:${key}`
export const toolPath = (name: string) => `/agents#${encodeURIComponent(`tool:${name}`)}`
export const flowPath = (id: string) => `/flows/${id}`
export const nodePath = (id: string) => `/?node=${encodeURIComponent(id)}`

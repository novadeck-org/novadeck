// The only kind of address a page view loads, for both halves of the browser viewer.

/** Whether `url` is an http(s) address, the only kind a page view loads. */
export const webAddress = (url: string): boolean => {
  try {
    const { protocol } = new URL(url)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

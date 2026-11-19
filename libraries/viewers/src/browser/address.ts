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

// A scheme the person wrote, as `mailto:` or `http:`: letters, then a colon that no port's
// digits follow, as `localhost:5173`'s do.
const schemed = /^[a-z][a-z\d+.-]*:(?!\d)/i

// This machine, which serves plain http: `localhost` and its subdomains, IPv4's loopback
// range, IPv6's, and the address that listens on every interface.
const loopback = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  /^127(?:\.\d{1,3}){3}$/.test(host) ||
  host === "[::1]" ||
  host === "0.0.0.0"

/**
 * The address the person means by what they typed, as a browser's address bar takes it: an
 * http(s) one as it is; one with no scheme over https, or over http where it's this machine
 * (`localhost:5173`), as development servers serve; undefined for any other scheme
 * (`javascript:`, `file:`) and for what's no address at all, as words with spaces.
 */
export const addressOf = (typed: string): string | undefined => {
  const text = typed.trim()
  if (text === "" || /\s/.test(text)) return undefined
  if (schemed.test(text)) return webAddress(text) ? new URL(text).href : undefined
  try {
    const { hostname } = new URL(`http://${text}`)
    if (hostname === "") return undefined
    const address = new URL(`${loopback(hostname) ? "http" : "https"}://${text}`)
    return address.href
  } catch {
    return undefined
  }
}

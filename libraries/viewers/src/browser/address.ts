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

// This machine and the network it's on, whose development servers serve plain http:
// `localhost` and its subdomains, IPv4's loopback and private ranges (as a virtual machine's
// or a phone's on the same Wi-Fi), IPv6's loopback, the address that listens on every
// interface, and names only the local network answers (`.local`).
const local = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host.endsWith(".local") ||
  /^(?:127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})$/.test(
    host,
  ) ||
  host === "[::1]" ||
  host === "0.0.0.0"

// Whether an address names a user or a password, which is no address to show: a show of
// one is refused too, as it would show them.
const credentialed = (url: URL): boolean => url.username !== "" || url.password !== ""

/**
 * The address the person means by what they typed, as a browser's address bar takes it: an
 * http(s) one as it is; one with no scheme over https, or over http where it's this machine
 * or its network (`localhost:5173`, `192.168.1.5:3000`), as development servers serve;
 * undefined for any other scheme (`javascript:`, `file:`), for one naming a user or a
 * password, and for what's no address at all, as words with spaces.
 */
export const addressOf = (typed: string): string | undefined => {
  const text = typed.trim()
  if (text === "" || /\s/.test(text)) return undefined
  try {
    if (schemed.test(text)) {
      if (!webAddress(text)) return undefined
      const address = new URL(text)
      return credentialed(address) ? undefined : address.href
    }
    const { hostname } = new URL(`http://${text}`)
    if (hostname === "") return undefined
    const address = new URL(`${local(hostname) ? "http" : "https"}://${text}`)
    return credentialed(address) ? undefined : address.href
  } catch {
    return undefined
  }
}

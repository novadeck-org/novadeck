import { WebLinksAddon } from "@xterm/addon-web-links"
import type { ILinkHandler, Terminal } from "@xterm/xterm"

type Click = Pick<MouseEvent, "button" | "ctrlKey" | "metaKey">
type Platform = "mac" | "other"

const currentPlatform = (): Platform =>
  /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other"

// A link opens on a primary ⌘-click on Apple platforms and Ctrl-click elsewhere, so a plain
// click still selects text or reaches a program that reads the mouse.
export const opensLink = (event: Click, platform: Platform): boolean =>
  event.button === 0 && (platform === "mac" ? event.metaKey : event.ctrlKey)

export const linkHint = (platform: Platform): string =>
  platform === "mac" ? "⌘-click to open" : "Ctrl-click to open"

// Only web pages leave the app; a terminal's output can name any scheme. An address that
// carries a login names its real host only after it, so it stays closed.
export const webLink = (text: string): string | undefined => {
  try {
    const url = new URL(text)
    if (url.username || url.password) return undefined
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

// The desktop host hands a page the app opens to the system browser; a browser opens a tab.
const openPage = (url: string): void => void window.open(url, "_blank", "noopener,noreferrer")

// What hovering a link shows: where it goes, since a hyperlink's text can name another
// address, and the click that opens it.
export const linkTitle = (text: string, platform: Platform): string => {
  const url = webLink(text)
  return url ? `${url}\n${linkHint(platform)}` : text
}

// Links in a terminal: addresses in its text and the hyperlinks a program prints (OSC 8).
export const linkTerminal = (
  xterm: Terminal,
  { platform = currentPlatform(), open = openPage } = {},
): void => {
  const activate = (event: MouseEvent, text: string): void => {
    const url = webLink(text)
    if (url && opensLink(event, platform)) open(url)
  }
  const hint = {
    hover: (_event: MouseEvent, text: string) =>
      xterm.element?.setAttribute("title", linkTitle(text, platform)),
    leave: () => xterm.element?.removeAttribute("title"),
  }
  const handler: ILinkHandler = { activate, ...hint }
  xterm.options.linkHandler = handler
  xterm.loadAddon(new WebLinksAddon(activate, hint))
}

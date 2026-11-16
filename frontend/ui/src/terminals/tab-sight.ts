// Marks each tab of a Terminals list scrolled out of its sight (data-offscreen), so its
// spinners and blinks rest there (tabs.css): a long list of working agents otherwise keeps
// every one of them ticking, which the engine pays for in style work on each frame, scrolled
// out of sight or not. A margin wakes a tab's marks just before it scrolls in. Tabs come and
// go with the roster and with each drag, which remounts them all, so new ones are watched as
// they join. Where the browser has no observer, every tab stays marked in sight.
const wakeMargin = "64px 0px"

const tabsIn = (node: Node): readonly HTMLElement[] =>
  node instanceof HTMLElement
    ? [
        ...(node.matches("[data-terminal-tab-id]") ? [node] : []),
        ...node.querySelectorAll<HTMLElement>("[data-terminal-tab-id]"),
      ]
    : []

export const restOffscreenTabs = (list: HTMLElement): (() => void) => {
  if (typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined")
    return () => {}
  const sight = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        if (isIntersecting) target.removeAttribute("data-offscreen")
        else target.setAttribute("data-offscreen", "")
      }
    },
    { root: list, rootMargin: wakeMargin },
  )
  const watch = (node: Node) => tabsIn(node).forEach((tab) => sight.observe(tab))
  const joined = new MutationObserver((records) =>
    records.forEach((record) => record.addedNodes.forEach(watch)),
  )
  watch(list)
  joined.observe(list, { childList: true, subtree: true })
  return () => {
    joined.disconnect()
    sight.disconnect()
    tabsIn(list).forEach((tab) => tab.removeAttribute("data-offscreen"))
  }
}

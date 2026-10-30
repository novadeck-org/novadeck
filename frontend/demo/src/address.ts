// What the page's address asks of the demo: the parameters after the `?` in its hash, as
// `#/?demo=agents&turnMs=4000`, which specs and the debug panel set before the app mounts.
export const addressParams = (): URLSearchParams =>
  new URLSearchParams(window.location.hash.split("?")[1] ?? "")

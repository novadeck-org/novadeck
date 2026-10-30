import type { DesktopApp } from "@novadeck/protocol/bridge"
import { pageRenderers, reportRenderers } from "@novadeck/terminal-views/renderers"

// Has the host log how the page's WebGL pool fares, where the host takes the report.
export const reportPoolTo = (
  host: DesktopApp | undefined,
  pool: Parameters<typeof reportRenderers>[0] = pageRenderers(),
): void => {
  const report = host?.reportRendererPool
  if (report) reportRenderers(pool, (stats) => report(stats))
}

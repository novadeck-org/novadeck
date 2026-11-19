import { lazy, Suspense, type ComponentType, type ReactNode } from "react"

/**
 * A kind's body (its pane or its peek) whose code loads when it first shows, so the workspace's
 * first load never carries a viewer it may not need; `fallback` stands in till it's in.
 */
export const lazyBody = <P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode,
): ComponentType<P> => {
  const Body = lazy(() => load().then((body) => ({ default: body })))
  return (props: P) => (
    <Suspense fallback={fallback}>
      <Body {...props} />
    </Suspense>
  )
}

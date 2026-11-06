import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"

// A hook in a component of its own, as a test drives it: what it gave last, and its props to
// give it again.
export const renderHook = <Props, Result>(
  hook: (props: Props) => Result,
  initial: Props,
): {
  readonly result: { current: Result }
  readonly rerender: (props: Props) => void
  readonly unmount: () => void
} => {
  const result = { current: undefined as Result }
  const onResult = (value: Result): void => {
    result.current = value
  }
  const Host = ({ props }: { readonly props: Props }): null => {
    onResult(hook(props))
    return null
  }
  const view = render(createElement(Host, { props: initial }))
  return {
    result,
    rerender: (props) => view.rerender(createElement(Host, { props })),
    unmount: view.unmount,
  }
}

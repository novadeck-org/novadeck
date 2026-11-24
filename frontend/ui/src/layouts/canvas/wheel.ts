// What scrolls inside a Canvas window marks itself `nowheel`, as React Flow names it, so the
// wheel over it scrolls it rather than zooming the canvas. React Flow's check keeps every
// wheel there, Ctrl+wheel and pinch too, which left nothing in a window's chat or pane to zoom
// the canvas by. So each window hands those on itself (`zoomPastNoWheel`): Ctrl+wheel, Cmd+wheel
// or a pinch over it zooms the canvas, as it does over a terminal's output (MountedTerminal),
// while the plain wheel stays with what it is over, its handlers and all. A viewer that zooms
// its own content by them, as an image or a PDF does, cancels the wheel and keeps it.
//
// For a native wheel listener on a window, which runs after anything inside it and before
// React Flow's on its zoom pane around it. React Flow passes over a wheel from inside
// `nowheel`, so the zoom pane gets a copy of it from itself, at the same place.
export const zoomPastNoWheel = (event: WheelEvent): void => {
  if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)) return
  if (!(event.target instanceof Element) || !event.target.closest(".nowheel")) return
  const pane = event.target.closest(".react-flow__renderer")
  if (!pane) return
  // The page's own zoom, and what inside would take it as a scroll, never see it.
  event.preventDefault()
  event.stopPropagation()
  pane.dispatchEvent(new WheelEvent(event.type, event))
}

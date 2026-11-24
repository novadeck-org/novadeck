// What scrolls inside a Canvas window marks itself `nowheel`, as React Flow names it, so the
// wheel over it scrolls it rather than zooming the canvas. React Flow's own check keeps every
// wheel there, Ctrl+wheel and pinch too, which left nothing in a window's chat or pane to zoom
// the canvas by. So Canvas checks it itself, on each window (`keepWheel`), and gives React Flow
// a class nothing wears (`unusedNoWheelClass`): the wheel scrolls what it is over, and
// Ctrl+wheel, Cmd+wheel or a pinch zooms the canvas, as it does over a terminal's output
// (MountedTerminal). A viewer that zooms its own content by them, as an image or a PDF does,
// cancels the wheel and keeps it.
export const unusedNoWheelClass = "canvas-no-wheel-unused"

// For a native, passive wheel listener on a window, which runs after anything inside it and
// before React Flow's on the pane around it.
export const keepWheel = (event: WheelEvent): void => {
  if (!(event.target instanceof Element) || !event.target.closest(".nowheel")) return
  if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey)) event.stopPropagation()
}

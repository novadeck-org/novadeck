import { htmlFrameViewer } from "./frame-viewer.js"

// The web page viewer's code as its frame runs it: the app bundles this into one script
// (`?frame`, see @novadeck/build-kit/frame-bundles), which sets the frame's entry.
;(self as unknown as { frameViewer: typeof htmlFrameViewer }).frameViewer = htmlFrameViewer

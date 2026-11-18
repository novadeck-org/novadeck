import { modelFrameViewer } from "./frame-viewer.js"

// The 3D model viewer's code as its frame runs it: the app bundles this, three.js and its
// loaders into one script (`?frame`, see @novadeck/build-kit/frame-bundles), which sets the
// frame's entry.
;(self as unknown as { frameViewer: typeof modelFrameViewer }).frameViewer = modelFrameViewer

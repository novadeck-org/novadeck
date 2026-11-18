// A viewer's code as its sandboxed frame runs it, bundled into one script and imported as its
// text (@novadeck/build-kit/frame-bundles).
declare module "*?frame" {
  const code: string
  export default code
}

import {
  AnimationMixer,
  Box3,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  LoadingManager,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  Sphere,
  Spherical,
  Vector3,
  WebGLRenderer,
  type AnimationClip,
} from "three"
import { unzipSync } from "three/addons/libs/fflate.module.js"
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { MTLLoader } from "three/addons/loaders/MTLLoader.js"
import { OBJLoader } from "three/addons/loaders/OBJLoader.js"
import { PLYLoader } from "three/addons/loaders/PLYLoader.js"
import { STLLoader } from "three/addons/loaders/STLLoader.js"

import { glbJson, gltfTrouble, millimetresPer, zipTrouble, type ClaimTrouble } from "./checks.js"
import type { ModelFormat, ModelTrouble, ModelView } from "./messages.js"

// The 3D model viewer as it runs in its frame (frame/frame.html), never in the app's page: it
// takes the model's bytes and the files beside it the runner read over the port, draws them
// with three.js, and says only what model/messages.ts lets through: where the camera is and
// what's toggled, why a model isn't drawn, whether it's busy, a still of it, and the pane's
// actions for its keys. Its network is none (the frame's policy): a file it names is only one
// the app handed it, by name, and any other address is never asked for.
//
// It draws only when something changes (a drag, a toggle, a new size, a playing animation), and
// lets go of its WebGL context while it can't be seen, so a canvas of many panes doesn't run
// out of them. A model written again is drawn where the camera was, as a CAD loop rewrites it.

/** A file the model names, as the runner read it; or one it didn't, with why. */
type Named = { readonly name: string; readonly bytes: ArrayBuffer }
type Refused = { readonly name: string; readonly reason: string }

type Open = {
  readonly format: ModelFormat
  readonly bytes: ArrayBuffer
  readonly files: readonly Named[]
  readonly refused: readonly Refused[]
}

// A model as loaded: what's drawn, its animations, how many millimetres a unit is (where the
// format says), and whether its up is Z, as CAD's is.
type Loaded = {
  readonly object: Object3D
  readonly clips: readonly AnimationClip[]
  readonly millimetres: number | undefined
  readonly zUp: boolean
}

const css = `
html, body { margin: 0; height: 100%; overflow: hidden; }
body {
  background: var(--model-ground, Canvas);
  color: var(--model-notice-fg, CanvasText);
  font: 12px/1.4 var(--model-chip-font, system-ui, sans-serif);
  user-select: none;
}
canvas { display: block; position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; outline: none; }
.bar, .size { position: absolute; bottom: 8px; display: flex; gap: 4px; }
.bar { left: 8px; }
.size { right: 8px; }
.bar button, .size span {
  font: inherit;
  padding: 3px 8px;
  border: var(--model-chip-border, 0);
  border-radius: var(--model-chip-radius, 6px);
  background: var(--model-chip-bg, rgb(0 0 0 / 0.55));
  color: var(--model-chip-fg, white);
  box-shadow: var(--model-chip-shadow, none);
}
.bar button { cursor: pointer; }
.bar button:hover { background: var(--model-chip-hover-bg, var(--model-chip-bg, rgb(0 0 0 / 0.7))); }
.bar button[aria-pressed="true"] { background: var(--model-chip-on-bg, var(--model-chip-hover-bg, rgb(0 0 0 / 0.8))); }
.bar button:focus-visible { outline: 2px solid var(--model-chip-fg, white); outline-offset: 1px; }
.bar[hidden], .size[hidden], .notice[hidden], .refused[hidden], button[hidden] { display: none; }
.notice { position: absolute; inset: 0; margin: auto; height: fit-content; padding: 24px; text-align: center; }
.refused { position: absolute; top: 8px; left: 8px; right: 8px; margin: 0; opacity: 0.8; }
`

// How far the view turns for a pixel dragged, and zooms for one scrolled; the furthest and
// nearest it goes, by the model's size.
const turnPerPixel = Math.PI / 400
const zoomPerPixel = 0.0015
const nearest = 0.05
const furthest = 50

const say = (reason: string): string =>
  ({
    external: "an address of its own",
    outside: "outside the model's folder",
    missing: "not there",
    "not-a-file": "not a file",
    secret: "may hold secrets",
    "too-large": "too large",
    unreadable: "can't be read",
  })[reason] ?? reason

const troubleText: Record<ModelTrouble, string> = {
  unreadable: "This isn't a model Novadeck can read.",
  unsupported:
    "This model is compressed in a way Novadeck can't read yet (Draco, Meshopt or Basis).",
  "too-large": "This model claims more than Novadeck draws.",
  empty: "This model has nothing to draw.",
  webgl: "3D drawing isn't available here.",
}

export const modelFrameViewer = ({ port }: { readonly port: MessagePort }): void => {
  const tell = (message: Record<string, unknown>, transfer: Transferable[] = []): void =>
    port.postMessage(message, transfer)

  const style = document.createElement("style")
  style.textContent = css
  document.head.append(style)
  const canvas = document.createElement("canvas")
  canvas.tabIndex = 0
  const bar = document.createElement("div")
  bar.className = "bar"
  bar.hidden = true
  const button = (text: string, act: () => void, pressable = true): HTMLButtonElement => {
    const made = document.createElement("button")
    made.type = "button"
    made.textContent = text
    if (pressable) made.setAttribute("aria-pressed", "false")
    made.addEventListener("click", act)
    bar.append(made)
    return made
  }
  const sizeBox = document.createElement("div")
  sizeBox.className = "size"
  sizeBox.hidden = true
  const sizeText = document.createElement("span")
  sizeBox.append(sizeText)
  const notice = document.createElement("p")
  notice.className = "notice"
  notice.hidden = true
  const refusedNote = document.createElement("p")
  refusedNote.className = "refused"
  refusedNote.hidden = true
  document.body.append(canvas, bar, sizeBox, refusedNote, notice)

  // The scene: a sky light and a light from the camera, as a model is best read; the grid on the
  // floor under it.
  const scene = new Scene()
  const camera = new PerspectiveCamera(45, 1, 0.01, 1000)
  scene.add(new HemisphereLight(0xffffff, 0x8890a0, 1.6))
  const headlight = new DirectionalLight(0xffffff, 1.4)
  headlight.position.set(0.5, 1, 1)
  camera.add(headlight)
  scene.add(camera)
  const holder = new Group()
  scene.add(holder)
  let grid: GridHelper | undefined

  let loaded: Loaded | undefined
  let mixer: AnimationMixer | undefined
  let opened = 0
  let urls: string[] = []
  // The model's size and centre, as drawn, and its size in millimetres where known.
  const bounds = new Sphere()
  const target = new Vector3()
  const spherical = new Spherical(1, Math.PI / 3, Math.PI / 4)
  const view = { grid: true, wireframe: false, flat: false, playing: false }
  // A view to go to once a model is in, as a saved one; else it's fitted.
  let wanted: ModelView | undefined
  let placed = false
  let surface = new Color(0xb8bec8)
  let gridColor = new Color(0x8890a0)

  // The renderer, made while the frame can be seen and has a size; let go of otherwise.
  let renderer: WebGLRenderer | undefined
  let visible = true
  let failed = false
  const make = (): WebGLRenderer | undefined => {
    if (renderer || failed || !visible || !loaded) return renderer
    const { clientWidth: width, clientHeight: height } = document.body
    if (width === 0 || height === 0) return undefined
    try {
      renderer = new WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: "low-power",
      })
    } catch {
      failed = true
      trouble("webgl")
      return undefined
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.setSize(width, height, false)
    return renderer
  }
  const release = (): void => {
    if (!renderer) return
    renderer.dispose()
    renderer.forceContextLoss()
    renderer = undefined
  }
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault()
    renderer = undefined
  })

  let frame = 0
  let last = 0
  const draw = (now: number): void => {
    frame = 0
    const drawing = make()
    if (!drawing) return
    if (mixer && view.playing) {
      mixer.update(last ? Math.min((now - last) / 1000, 0.1) : 0)
      last = now
      redraw()
    } else last = 0
    drawing.render(scene, camera)
  }
  const redraw = (): void => {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  // Where the camera is, said once it settles.
  let telling = 0
  const told = (): void => {
    clearTimeout(telling)
    telling = setTimeout(() => {
      if (!loaded) return
      tell({ type: "place", view: current() })
    }, 150) as unknown as number
  }
  const current = (): ModelView => ({
    target: triple(target),
    position: triple(camera.position),
    grid: view.grid,
    wireframe: view.wireframe,
    flat: view.flat,
    playing: view.playing,
  })

  const aim = (): void => {
    const offset = new Vector3().setFromSpherical(spherical)
    camera.position.copy(target).add(offset)
    camera.lookAt(target)
    const reach = Math.max(bounds.radius, 1e-6)
    camera.near = Math.max(spherical.radius - reach * 4, reach * 0.001)
    camera.far = spherical.radius + reach * 8
    camera.updateProjectionMatrix()
    redraw()
    told()
  }
  const fit = (): void => {
    target.copy(bounds.center)
    const half = (camera.fov * Math.PI) / 360
    const across = Math.min(half, Math.atan(Math.tan(half) * camera.aspect))
    spherical.radius = (Math.max(bounds.radius, 1e-6) / Math.sin(across)) * 1.1
    aim()
  }
  const goTo = (saved: ModelView): void => {
    target.fromArray(saved.target)
    spherical.setFromVector3(new Vector3().fromArray(saved.position).sub(target))
    spherical.makeSafe()
    for (const key of ["grid", "wireframe", "flat", "playing"] as const) view[key] = saved[key]
    looks()
    aim()
  }

  // Turning, moving and zooming the view: by a drag over it, the frame's own or one the glass
  // over it hands on, by the wheel, and by keys.
  const turn = (dx: number, dy: number): void => {
    spherical.theta -= dx * turnPerPixel
    spherical.phi -= dy * turnPerPixel
    spherical.makeSafe()
    aim()
  }
  const move = (dx: number, dy: number): void => {
    const height = Math.max(document.body.clientHeight, 1)
    const across = (2 * spherical.radius * Math.tan((camera.fov * Math.PI) / 360)) / height
    const right = new Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-dx * across)
    const up = new Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * across)
    target.add(right).add(up)
    aim()
  }
  const zoom = (by: number): void => {
    const reach = Math.max(bounds.radius, 1e-6)
    spherical.radius = Math.min(
      Math.max(spherical.radius * Math.exp(by), reach * nearest),
      reach * furthest,
    )
    aim()
  }

  type Drag = { x: number; y: number; moved: number; mode: "turn" | "move" | "zoom" }
  let drag: Drag | undefined
  const dragStart = (
    x: number,
    y: number,
    buttons: number,
    shift: boolean,
    ctrl: boolean,
  ): void => {
    const mode = buttons & 6 || shift ? "move" : ctrl ? "zoom" : "turn"
    drag = { x, y, moved: 0, mode }
  }
  const dragMove = (x: number, y: number): void => {
    if (!drag) return
    const dx = x - drag.x
    const dy = y - drag.y
    drag.moved += Math.abs(dx) + Math.abs(dy)
    drag.x = x
    drag.y = y
    if (drag.mode === "turn") turn(dx, dy)
    else if (drag.mode === "move") move(dx, dy)
    else zoom(dy * zoomPerPixel * 4)
  }
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId)
    canvas.focus()
    dragStart(
      event.offsetX,
      event.offsetY,
      event.buttons,
      event.shiftKey,
      event.ctrlKey || event.metaKey,
    )
  })
  canvas.addEventListener("pointermove", (event) => dragMove(event.offsetX, event.offsetY))
  const dropped = (): void => {
    drag = undefined
  }
  canvas.addEventListener("pointerup", dropped)
  canvas.addEventListener("pointercancel", dropped)
  canvas.addEventListener("contextmenu", (event) => event.preventDefault())
  const wheel = (deltaY: number, mode: number): void => {
    const pixels =
      mode === 1 ? deltaY * 16 : mode === 2 ? deltaY * document.body.clientHeight : deltaY
    zoom(pixels * zoomPerPixel)
  }
  addEventListener(
    "wheel",
    (event) => {
      event.preventDefault()
      wheel(event.deltaY, event.deltaMode)
    },
    { passive: false },
  )
  addEventListener("keydown", (event) => {
    const ctrl = event.ctrlKey || event.metaKey
    // The pane's keys, which the frame can't press for it: it asks.
    if (event.key === "Escape") return tell({ type: "action", action: "hide" })
    if (ctrl && event.key === "PageDown") return tell({ type: "action", action: "next-tab" })
    if (ctrl && event.key === "PageUp") return tell({ type: "action", action: "previous-tab" })
    if (ctrl || event.altKey || (event.target as Element | null)?.closest?.(".bar")) return
    const step = 24
    const shift = event.shiftKey
    const keys: Record<string, () => void> = {
      ArrowLeft: () => (shift ? move(-step, 0) : turn(-step, 0)),
      ArrowRight: () => (shift ? move(step, 0) : turn(step, 0)),
      ArrowUp: () => (shift ? move(0, -step) : turn(0, -step)),
      ArrowDown: () => (shift ? move(0, step) : turn(0, step)),
      "+": () => zoom(-0.15),
      "=": () => zoom(-0.15),
      "-": () => zoom(0.15),
      _: () => zoom(0.15),
      "0": fit,
      f: fit,
      g: () => toggle("grid"),
      w: () => toggle("wireframe"),
      l: () => toggle("flat"),
      " ": () => toggle("playing"),
    }
    const act = keys[event.key]
    if (!act) return
    event.preventDefault()
    act()
  })

  // The bar: fit, the grid, wireframe and flat shading, and an animation's play and pause.
  const fitButton = button("Fit", fit, false)
  fitButton.title = "Fit the model in view (F)"
  const toggles = {
    grid: button("Grid", () => toggle("grid")),
    wireframe: button("Wireframe", () => toggle("wireframe")),
    flat: button("Flat", () => toggle("flat")),
    playing: button("Play", () => toggle("playing")),
  }
  toggles.grid.title = "Show the grid (G)"
  toggles.wireframe.title = "Draw edges only (W)"
  toggles.flat.title = "Flat shading (L)"
  toggles.playing.title = "Play the animation (Space)"
  const toggle = (key: keyof typeof view): void => {
    if (key === "playing" && !mixer) return
    view[key] = !view[key]
    looks()
    redraw()
    told()
  }
  // The model as the toggles say.
  const looks = (): void => {
    for (const [key, made] of Object.entries(toggles))
      made.setAttribute("aria-pressed", String(view[key as keyof typeof view]))
    toggles.playing.textContent = view.playing ? "Pause" : "Play"
    toggles.playing.hidden = !mixer
    if (grid) grid.visible = view.grid
    holder.traverse((object) => {
      const materials = (object as Mesh).material
      if (!materials) return
      for (const material of Array.isArray(materials) ? materials : [materials]) {
        const shaded = material as MeshStandardMaterial
        if ("wireframe" in shaded) shaded.wireframe = view.wireframe
        if ("flatShading" in shaded && shaded.flatShading !== view.flat) {
          shaded.flatShading = view.flat
          shaded.needsUpdate = true
        }
      }
    })
  }

  const trouble = (kind: ModelTrouble | null): void => {
    notice.hidden = kind === null
    notice.textContent = kind ? troubleText[kind] : ""
    tell({ type: "trouble", trouble: kind })
  }

  // A drag the glass handed on that never moved is a press: on the bar, it presses its button.
  const handed = (message: {
    phase: string
    x: number
    y: number
    buttons: number
    shift: boolean
    ctrl: boolean
  }) => {
    if (message.phase === "start")
      return dragStart(message.x, message.y, message.buttons, message.shift, message.ctrl)
    if (message.phase === "move") return dragMove(message.x, message.y)
    const pressed = drag && drag.moved < 4
    drag = undefined
    if (!pressed) return
    const hit = document.elementFromPoint(message.x, message.y)
    if (hit instanceof HTMLButtonElement && bar.contains(hit)) hit.click()
  }

  const open = async (given: Open): Promise<void> => {
    const at = (opened += 1)
    tell({ type: "busy", busy: true })
    for (const url of urls) URL.revokeObjectURL(url)
    urls = []
    let next: Loaded | ClaimTrouble
    try {
      next = await load(given)
    } catch {
      next = "unreadable"
    }
    // A newer file came while this one loaded: that one's drawn.
    if (at !== opened) return
    tell({ type: "busy", busy: false })
    const missing = given.refused.map(({ name, reason }) => `${name} (${say(reason)})`)
    refusedNote.hidden = missing.length === 0
    refusedNote.textContent = missing.length ? `Not read: ${missing.join(", ")}` : ""
    if (typeof next === "string") {
      drop()
      return trouble(next)
    }
    show(next)
  }

  const drop = (): void => {
    mixer?.stopAllAction()
    mixer = undefined
    // What the last model held, let go of.
    holder.traverse((object) => {
      const mesh = object as Mesh
      mesh.geometry?.dispose()
      const materials = mesh.material
      if (!materials) return
      for (const material of Array.isArray(materials) ? materials : [materials]) {
        for (const value of Object.values(material))
          if ((value as { isTexture?: boolean } | null)?.isTexture)
            (value as { dispose: () => void }).dispose()
        material.dispose()
      }
    })
    plain.clear()
    holder.clear()
    if (grid) scene.remove(grid)
    grid = undefined
    loaded = undefined
    bar.hidden = true
    sizeBox.hidden = true
    redraw()
  }

  const show = (next: Loaded): void => {
    const box = new Box3().setFromObject(next.object)
    if (box.isEmpty()) {
      drop()
      return trouble("empty")
    }
    drop()
    loaded = next
    holder.add(next.object)
    // CAD's Z up, turned to three.js's Y up.
    holder.rotation.x = next.zUp ? -Math.PI / 2 : 0
    holder.updateMatrixWorld(true)
    const drawn = new Box3().setFromObject(holder)
    drawn.getBoundingSphere(bounds)
    const size = box.getSize(new Vector3())
    const unit = next.millimetres
    sizeText.textContent = `${[size.x, size.y, size.z].map((side) => number(side * (unit ?? 1))).join(" × ")} ${unit === undefined ? "units" : "mm"}`
    sizeBox.title =
      unit === undefined ? "This format has no units: one unit may be a millimetre." : ""
    sizeBox.hidden = false
    // The grid on the floor, a little wider than the model, in round steps.
    const across = Math.max(drawn.max.x - drawn.min.x, drawn.max.z - drawn.min.z) * 1.5
    const step = 10 ** Math.floor(Math.log10(Math.max(across, 1e-9) / 10))
    const cells = Math.max(2, Math.ceil(across / step / 2) * 2)
    grid = new GridHelper(cells * step, cells, gridColor, gridColor)
    grid.position.set(bounds.center.x, drawn.min.y, bounds.center.z)
    scene.add(grid)
    mixer = next.clips.length ? new AnimationMixer(next.object) : undefined
    for (const clip of next.clips) mixer?.clipAction(clip).play()
    if (!mixer) view.playing = false
    paint()
    bar.hidden = false
    trouble(null)
    if (wanted) {
      goTo(wanted)
      wanted = undefined
      placed = true
    } else if (!placed) {
      fit()
      placed = true
    } else aim()
    looks()
    redraw()
  }

  // The materials of meshes the format gave none of their own, in the model's colour.
  const plain = new Set<MeshStandardMaterial | PointsMaterial>()
  const paint = (): void => {
    for (const material of plain) (material as MeshStandardMaterial).color.copy(surface)
    redraw()
  }
  const plainMaterial = (colours: boolean): MeshStandardMaterial => {
    const made = new MeshStandardMaterial({
      color: colours ? 0xffffff : surface,
      vertexColors: colours,
      metalness: 0.05,
      roughness: 0.75,
    })
    if (!colours) plain.add(made)
    return made
  }
  // A geometry as drawn: its faces, or, a point cloud's, its points.
  const meshOf = (geometry: BufferGeometry, points = false): Object3D => {
    const colours = geometry.hasAttribute("color")
    if (points) {
      const material = new PointsMaterial({
        size: 2,
        sizeAttenuation: false,
        vertexColors: colours,
        color: colours ? 0xffffff : surface,
      })
      if (!colours) plain.add(material)
      return new Points(geometry, material)
    }
    if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals()
    return new Mesh(geometry, plainMaterial(colours))
  }

  // A manager that answers each file the model names with the one the runner read, by its name
  // as written; anything else, an address of its own among them, is never asked for.
  const managerFor = (files: readonly Named[]): LoadingManager => {
    const named = new Map<string, string>()
    for (const { name, bytes } of files) {
      const url = URL.createObjectURL(new Blob([bytes]))
      urls.push(url)
      named.set(name, url)
    }
    const manager = new LoadingManager()
    manager.setURLModifier((url) => {
      const found = named.get(url) ?? named.get(decodeURIComponentSafe(url))
      if (found) return found
      // What the model holds itself, and what a loader made of it.
      if (url.startsWith("data:") || url.startsWith("blob:")) return url
      return "data:,"
    })
    return manager
  }

  const load = async ({ format, bytes, files }: Open): Promise<Loaded | ClaimTrouble> => {
    const text = (): string => new TextDecoder().decode(bytes)
    switch (format) {
      case "glb":
      case "gltf": {
        const json = format === "glb" ? glbJson(bytes) : parseJson(text())
        const claims = gltfTrouble(json)
        if (claims) return claims
        const gltf = await new GLTFLoader(managerFor(files)).parseAsync(
          format === "glb" ? bytes : text(),
          "",
        )
        // glTF's unit is the metre.
        return { object: gltf.scene, clips: gltf.animations, millimetres: 1000, zUp: false }
      }
      case "stl":
        return {
          object: meshOf(new STLLoader().parse(bytes)),
          clips: [],
          millimetres: undefined,
          zUp: true,
        }
      case "ply": {
        // A PLY with no faces is a point cloud.
        const geometry = new PLYLoader().parse(bytes)
        return {
          object: meshOf(geometry, !geometry.index),
          clips: [],
          millimetres: undefined,
          zUp: true,
        }
      }
      case "obj": {
        const manager = managerFor(files)
        const loader = new OBJLoader(manager)
        // Its materials, from each library it names that the runner read.
        const libraries = files.filter(({ name }) => /\.mtl$/i.test(name))
        if (libraries.length) {
          const reader = new MTLLoader(manager)
          const decoder = new TextDecoder()
          // A library's textures are named from its own folder, as the runner lists them.
          const creators = libraries.map(({ name, bytes: library }) =>
            reader.parse(decoder.decode(library), name.slice(0, name.lastIndexOf("/") + 1)),
          )
          const creator = creators[0]!
          creator.setMaterials(Object.assign({}, ...creators.map((each) => each.materialsInfo)))
          creator.preload()
          loader.setMaterials(creator)
        }
        const object = loader.parse(text())
        object.traverse((each) => {
          const mesh = each as Mesh
          if (mesh.isMesh && !libraries.length) mesh.material = plainMaterial(false)
        })
        return { object, clips: [], millimetres: undefined, zUp: false }
      }
      case "3mf": {
        const claims = zipTrouble(bytes)
        if (claims) return claims
        const object = new ThreeMFLoader(managerFor(files)).parse(bytes)
        return { object, clips: [], millimetres: threeMfUnit(bytes), zUp: true }
      }
    }
  }

  // The look: the app's tokens, as the frame's own properties, and the model's colours from them.
  const theme = (tokens: Record<string, string>, scheme: "light" | "dark"): void => {
    document.documentElement.style.colorScheme = scheme
    for (const [name, value] of Object.entries(tokens))
      if (name.startsWith("--model-")) document.documentElement.style.setProperty(name, value)
    surface = colourOf("--model-surface", scheme === "dark" ? "#aeb6c2" : "#9aa3b0")
    gridColor = colourOf("--model-grid", scheme === "dark" ? "#4a505a" : "#c5cad3")
    if (grid) {
      const materials = grid.material as Material | Material[]
      for (const material of Array.isArray(materials) ? materials : [materials])
        (material as unknown as { color: Color }).color.copy(gridColor)
    }
    paint()
  }

  // A still of the model, fitted, for a peek or a folder's grid: a PNG of `size` square.
  const still = async (id: number, size: number): Promise<void> => {
    if (!loaded || failed) return tell({ type: "thumb", id, bytes: null })
    const paper = document.createElement("canvas")
    let painter: WebGLRenderer
    try {
      painter = new WebGLRenderer({
        canvas: paper,
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      })
    } catch {
      return tell({ type: "thumb", id, bytes: null })
    }
    painter.setPixelRatio(1)
    painter.setSize(size, size, false)
    const lens = new PerspectiveCamera(35, 1, 0.01, 1000)
    lens.add(headlight.clone())
    scene.add(lens)
    const half = (lens.fov * Math.PI) / 360
    const distance = (Math.max(bounds.radius, 1e-6) / Math.sin(half)) * 1.05
    lens.position
      .copy(bounds.center)
      .add(new Vector3().setFromSpherical(new Spherical(distance, Math.PI / 3, Math.PI / 4)))
    lens.lookAt(bounds.center)
    lens.near = distance / 100
    lens.far = distance * 10
    lens.updateProjectionMatrix()
    const shown = grid?.visible
    if (grid) grid.visible = false
    painter.render(scene, lens)
    if (grid && shown !== undefined) grid.visible = shown
    scene.remove(lens)
    const blob = await new Promise<Blob | null>((done) => paper.toBlob(done, "image/png"))
    painter.dispose()
    painter.forceContextLoss()
    const data = blob ? await blob.arrayBuffer() : null
    tell({ type: "thumb", id, bytes: data }, data ? [data] : [])
  }

  // Its size, and whether it can be seen: none, or out of view, lets go of the renderer.
  const sized = (): void => {
    const { clientWidth: width, clientHeight: height } = document.body
    if (width === 0 || height === 0 || !visible) return release()
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer?.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer?.setSize(width, height, false)
    redraw()
  }
  new ResizeObserver(sized).observe(document.body)
  const density = (): void => {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        sized()
        density()
      },
      { once: true },
    )
  }
  density()

  let loading: Promise<void> = Promise.resolve()
  port.addEventListener("message", ({ data }) => {
    const message = data as { type: string } & Record<string, unknown>
    switch (message.type) {
      case "label":
        document.title = String(message.label)
        canvas.setAttribute("aria-label", String(message.label))
        return
      case "theme":
        return theme(message.tokens as Record<string, string>, message.scheme as "light" | "dark")
      case "focus":
        return canvas.focus({ preventScroll: true })
      case "open":
        loading = open(message as unknown as Open)
        return
      case "place": {
        const saved = message.view as ModelView
        if (loaded) goTo(saved)
        else wanted = saved
        placed = true
        return
      }
      case "wheel":
        return wheel(message.y as number, message.mode as number)
      case "drag":
        return handed(message as unknown as Parameters<typeof handed>[0])
      case "visible":
        visible = message.visible === true
        if (!visible) release()
        return sized()
      case "thumb":
        // Of the model opened before it, once it's in.
        return void loading.then(() => still(message.id as number, message.size as number))
    }
  })
  port.start()
  tell({ type: "ready" })
}

const triple = (vector: Vector3): [number, number, number] => [vector.x, vector.y, vector.z]

// A token's colour as three.js takes it, as the frame's page computes it, its alpha dropped.
const colourOf = (name: string, fallback: string): Color => {
  const probe = document.createElement("i")
  probe.style.color =
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  document.body.append(probe)
  const colour = getComputedStyle(probe).color
  probe.remove()
  try {
    return new Color(colour.replace(/ \/ [\d.]+\)/, ")"))
  } catch {
    return new Color(fallback)
  }
}

const number = (value: number): string =>
  Math.abs(value) >= 100
    ? value.toFixed(0)
    : Math.abs(value) >= 10
      ? value.toFixed(1)
      : value.toFixed(2)

const parseJson = (text: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const decodeURIComponentSafe = (url: string): string => {
  try {
    return decodeURIComponent(url)
  } catch {
    return url
  }
}

// The unit a 3MF's model names, in millimetres: its root's `unit`, millimetres if none.
const threeMfUnit = (bytes: ArrayBuffer): number => {
  try {
    const entries = unzipSync(new Uint8Array(bytes), {
      filter: (file) => /\.model$/i.test(file.name),
    })
    const first = Object.values(entries)[0]
    if (!first) return 1
    const head = new TextDecoder().decode(first.subarray(0, 4096))
    const unit = /<model[^>]*\sunit="([a-z]+)"/i.exec(head)?.[1]
    return (unit && millimetresPer[unit]) || 1
  } catch {
    return 1
  }
}

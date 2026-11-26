// The game's models: every character, unit, enemy and prop is a glTF file in models/
// (models/README.md says how to make one). Two ways to use one:
//
//   loadModel("robot")        a three.js object, for a 3D scene
//   modelPicture("robot")     a turning picture on a canvas, for a 2D game (a Phaser texture)
import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"

const loader = new GLTFLoader()

// models/<name>.gltf as a three.js object, standing on the ground (y = 0), centred on x and z;
// the placeholder where that model isn't made yet (the page reloads once it is). Call it once
// per kind and .clone() the result for more of the same.
export const loadModel = async (name) => {
  const { scene: model } = await loader
    .loadAsync(`models/${name}.gltf`)
    .catch(() => loader.loadAsync("models/placeholder.gltf"))
  const box = new THREE.Box3().setFromObject(model)
  const centre = box.getCenter(new THREE.Vector3())
  model.position.set(-centre.x, -box.min.y, -centre.z)
  const group = new THREE.Group()
  group.name = name
  group.add(model)
  return group
}

// models/<name>.gltf as a picture: { canvas, draw(time) }. The canvas is size x size with a
// clear background; draw(time) redraws it with the model turned a little, so call it each frame
// for a turning picture, or once for a still one. In Phaser:
//
//   const robot = await modelPicture("robot")        // before the game starts
//   this.textures.addCanvas("robot", robot.canvas)   // in a scene's create()
//   robot.draw(time); this.textures.get("robot").refresh()   // in update(), if it should turn
export const modelPicture = async (name, size = 256) => {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setSize(size, size, false)
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = size
  const pen = canvas.getContext("2d")

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x554466, 1.8))
  const sun = new THREE.DirectionalLight(0xffffff, 2.2)
  sun.position.set(3, 5, 4)
  scene.add(sun)

  const model = await loadModel(name)
  const box = new THREE.Box3().setFromObject(model)
  const reach = box.getSize(new THREE.Vector3()).length() || 1
  model.position.y = -(box.max.y - box.min.y) / 2
  const turntable = new THREE.Group()
  turntable.add(model)
  scene.add(turntable)

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
  camera.position.set(0, reach * 0.35, reach * 1.75)
  camera.lookAt(0, 0, 0)

  const draw = (time = 0) => {
    turntable.rotation.y = time / 900
    renderer.render(scene, camera)
    pen.clearRect(0, 0, size, size)
    pen.drawImage(renderer.domElement, 0, 0)
  }
  draw(0)
  return { canvas, draw }
}

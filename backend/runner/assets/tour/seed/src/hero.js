// The hero: the 3D model in model/hero.gltf, drawn by three.js, turning, and copied onto a
// plain canvas that the game uses as the hero's picture (see play.js and title.js).
import * as THREE from "three"
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import { config } from "./config.js"

const size = 256

// Where three.js can't draw (no WebGL here), the hero is a plain ball, so the game still runs.
const plainHero = () => {
  const picture = document.createElement("canvas")
  picture.width = picture.height = size
  const pen = picture.getContext("2d")
  pen.fillStyle = "#9a9aa6"
  pen.beginPath()
  pen.arc(size / 2, size / 2, size * 0.3, 0, Math.PI * 2)
  pen.fill()
  return { canvas: picture, draw: () => {} }
}

export const loadHero = () =>
  drawnHero().catch((error) => {
    console.warn("The hero's 3D model can't be drawn here, so it is a plain ball:", error)
    return plainHero()
  })

const drawnHero = async () => {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setSize(size, size, false)
  const picture = document.createElement("canvas")
  picture.width = picture.height = size
  const pen = picture.getContext("2d")

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x554466, 1.8))
  const sun = new THREE.DirectionalLight(0xffffff, 2.2)
  sun.position.set(3, 5, 4)
  scene.add(sun)
  // The city's neon, as a rim light from behind.
  const rim = new THREE.DirectionalLight(config.accent, 3)
  rim.position.set(-3, 2, -4)
  scene.add(rim)

  const { scene: model } = await new GLTFLoader().loadAsync("model/hero.gltf")
  // Centre the model and fit it in view, whatever its size.
  const box = new THREE.Box3().setFromObject(model)
  const centre = box.getCenter(new THREE.Vector3())
  const reach = box.getSize(new THREE.Vector3()).length() || 1
  model.position.sub(centre)
  const turntable = new THREE.Group()
  turntable.add(model)
  scene.add(turntable)

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
  camera.position.set(0, reach * 0.35, reach * 1.75)
  camera.lookAt(0, 0, 0)

  // Call draw() each frame: it turns the hero a little, draws it, and copies it to the picture.
  const draw = (time) => {
    turntable.rotation.y = time / 900
    renderer.render(scene, camera)
    pen.clearRect(0, 0, size, size)
    pen.drawImage(renderer.domElement, 0, 0)
  }
  draw(0)
  return { canvas: picture, draw }
}

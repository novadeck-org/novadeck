// Nothing is built yet: this shows the placeholder model turning, so you can see the page, the
// engine and the models work. Replace this file with the game.
import * as THREE from "three"
import { loadModel } from "./models.js"

const renderer = new THREE.WebGLRenderer({ antialias: true })
document.getElementById("game").append(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x17171c)
scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 2))

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
camera.position.set(0, 1.6, 6)
camera.lookAt(0, 0.5, 0)

const model = await loadModel("placeholder")
scene.add(model)

const fit = () => {
  renderer.setSize(innerWidth, innerHeight)
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
}
addEventListener("resize", fit)
fit()

renderer.setAnimationLoop((time) => {
  model.rotation.y = time / 1500
  renderer.render(scene, camera)
})

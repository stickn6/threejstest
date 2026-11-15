import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createPond } from './pond.js';
import { createSkyTexture } from './sky.js';

const HORIZON = '#dcebf2';
const GRASS = '#86b35a';

const canvas = document.querySelector('#app');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.NeutralToneMapping;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(HORIZON, 22, 95);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
camera.position.set(8.5, 5.2, 11.5);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.4, 0);
controls.enableDamping = true;
controls.minDistance = 4;
controls.maxDistance = 38;
controls.maxPolarAngle = Math.PI * 0.485; // stay above the ground

// Soft daylight: a warm sun, sky/ground bounce, and a matching sky.
const sun = new THREE.DirectionalLight('#fff1d8', 3.0);
sun.position.set(-10, 9.5, -8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -13;
sun.shadow.camera.right = 13;
sun.shadow.camera.top = 13;
sun.shadow.camera.bottom = -13;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 45;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 4;
scene.add(sun);
scene.add(new THREE.HemisphereLight('#d6ecff', '#a3ad84', 1.25));

const sunDirection = sun.position.clone().normalize();
scene.background = createSkyTexture({ sunDirection, horizon: HORIZON });

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(220, 64),
  new THREE.MeshStandardMaterial({ color: GRASS, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const pond = createPond({ size: 10, lilyPads: 8, sunDirection, grassColor: GRASS });
scene.add(pond);

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const timer = new THREE.Timer();
timer.connect(document); // pause while the tab is hidden
renderer.setAnimationLoop((timestamp) => {
  timer.update(timestamp);
  pond.userData.update(timer.getElapsed());
  controls.update();
  renderer.render(scene, camera);
});

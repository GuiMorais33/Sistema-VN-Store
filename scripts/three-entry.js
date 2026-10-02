// Só as peças do Three.js que as cenas usam. O build (scripts/build-three.sh)
// joga fora o resto e grava public/vendor/three-vn.min.js — assim o
// servidor não precisa de "npm install" nem de etapa de build para rodar.
export {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Points, Sprite,
  CylinderGeometry, TorusGeometry, PlaneGeometry, BufferGeometry, BufferAttribute,
  MeshStandardMaterial, MeshBasicMaterial, PointsMaterial, SpriteMaterial, ShaderMaterial,
  CanvasTexture, PMREMGenerator, Color, Fog, Vector2,
  AmbientLight, DirectionalLight, PointLight,
  AdditiveBlending, SRGBColorSpace, ACESFilmicToneMapping, MathUtils,
} from 'three';
export { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

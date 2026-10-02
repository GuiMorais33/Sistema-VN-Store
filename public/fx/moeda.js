// Tela de entrada: o logo da VN vira uma moeda cromada flutuando sobre um
// chão de grade neon, com poeira verde subindo. Segue o mouse (ou o
// giroscópio no celular) e dá um giro quando a senha entra.
import { palco, T } from '/fx/palco.js';

const VERDE = 0x2fd24f;

function texturaFace(img) {
  const N = 1024, c = document.createElement('canvas');
  c.width = c.height = N;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(N * 0.42, N * 0.36, N * 0.05, N / 2, N / 2, N / 2);
  g.addColorStop(0, '#17221a'); g.addColorStop(0.7, '#0a100b'); g.addColorStop(1, '#040604');
  x.fillStyle = g; x.fillRect(0, 0, N, N);
  // anel fino gravado perto da borda
  x.strokeStyle = 'rgba(85,245,118,.28)'; x.lineWidth = 6;
  x.beginPath(); x.arc(N / 2, N / 2, N * 0.455, 0, Math.PI * 2); x.stroke();
  // o desenho do logo ocupa x 146–354, y 48–301 do arquivo (o resto é transparente)
  const cx = 250, cy = 174.5, alt = 253, esc = (N * 0.78) / alt;
  x.drawImage(img, N / 2 - cx * esc, N / 2 - cy * esc, img.width * esc, img.height * esc);
  const t = new T.CanvasTexture(c);
  t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8;
  t.center.set(0.5, 0.5); t.rotation = Math.PI / 2;   // a tampa do cilindro deitado vem girada
  return t;
}

function texturaBrilho() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(85,245,118,.55)'); g.addColorStop(0.35, 'rgba(47,210,79,.18)'); g.addColorStop(1, 'rgba(47,210,79,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  return new T.CanvasTexture(c);
}

export async function montarMoeda(el, logoSrc = '/logo.webp') {
  const img = new Image(); img.src = logoSrc;
  try { await img.decode(); } catch (_) { return null; }

  const alvo = { x: 0, y: 0 };
  let giro = 0, giroVel = 0, zoom = 0, tremor = -9;

  const p = palco(el, {
    camera: { fov: 38, pos: [0, 0.35, 8] },
    setup({ scene, renderer }) {
      renderer.toneMapping = T.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      const pm = new T.PMREMGenerator(renderer);
      scene.environment = pm.fromScene(new T.RoomEnvironment(), 0.04).texture;
      scene.fog = new T.Fog(0x070907, 7, 22);

      // --- moeda ---
      const moeda = new T.Group();
      const cromo = new T.MeshStandardMaterial({ color: 0xe6edf1, metalness: 1, roughness: 0.2 });
      // a face não reage à luz: assim o logo sai com as cores de verdade
      const face = new T.MeshBasicMaterial({ map: texturaFace(img), toneMapped: false });
      const corpo = new T.Mesh(new T.CylinderGeometry(1.5, 1.5, 0.2, 128, 1), [cromo, face, face]);
      corpo.rotation.x = Math.PI / 2;
      const aro = new T.Mesh(new T.TorusGeometry(1.5, 0.085, 24, 160), cromo);
      const aroAtras = aro.clone(); aro.position.z = 0.1; aroAtras.position.z = -0.1;
      moeda.add(corpo, aro, aroAtras);

      const brilho = new T.Sprite(new T.SpriteMaterial({
        map: texturaBrilho(), blending: T.AdditiveBlending, depthWrite: false, transparent: true,
      }));
      brilho.scale.set(7.5, 7.5, 1); brilho.position.z = -0.6;

      const conjunto = new T.Group();
      conjunto.add(brilho, moeda);
      scene.add(conjunto);

      // --- luz: chave branca, contra-luz verde de baixo ---
      scene.add(new T.AmbientLight(0xffffff, 0.25));
      const chave = new T.DirectionalLight(0xffffff, 1.6); chave.position.set(3, 4, 6); scene.add(chave);
      const neon = new T.PointLight(VERDE, 30, 12, 2); neon.position.set(-2.5, -2.2, 1.5); scene.add(neon);

      // --- chão de grade (linhas desenhadas no shader, somem na névoa) ---
      const chao = new T.Mesh(new T.PlaneGeometry(60, 60), new T.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { uT: { value: 0 }, uCor: { value: new T.Color(VERDE) } },
        vertexShader: `varying vec2 vP; varying float vD;
          void main(){ vP = position.xy; vec4 mv = modelViewMatrix * vec4(position,1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `uniform float uT; uniform vec3 uCor; varying vec2 vP; varying float vD;
          void main(){
            vec2 q = vec2(vP.x, vP.y + uT) * 1.1;
            vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
            float l = 1.0 - min(min(g.x, g.y), 1.0);
            float fade = smoothstep(22.0, 4.0, vD) * smoothstep(0.0, 3.0, vD);
            gl_FragColor = vec4(uCor, l * fade * 0.55);
          }`,
      }));
      chao.rotation.x = -Math.PI / 2; chao.position.y = -2.4;
      scene.add(chao);

      // --- poeira verde ---
      const N = 380, pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 22;
        pos[i * 3 + 1] = Math.random() * 9 - 2.4;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 14 - 2;
      }
      const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      const poeira = new T.Points(geo, new T.PointsMaterial({
        color: 0x55f576, size: 0.045, transparent: true, opacity: 0.75,
        blending: T.AdditiveBlending, depthWrite: false,
      }));
      scene.add(poeira);

      return {
        conjunto, moeda, chao, poeira, pos,
        resize({ aspect }) {
          // deitado (computador): moeda à esquerda do formulário; em pé: acima dele
          if (aspect > 1.05) { conjunto.position.set(-Math.min(2.6, aspect * 1.25), 0.25, 0); conjunto.scale.setScalar(1); }
          else { conjunto.position.set(0, 1.55, 0); conjunto.scale.setScalar(Math.max(0.62, Math.min(0.85, aspect * 1.3))); }
        },
      };
    },
    frame({ cam, s }, t, dt) {
      giro += giroVel * dt;
      const tau = performance.now() / 1000 - tremor;
      const balanco = tau < 1.2 ? 0.45 * Math.sin(tau * 22) * Math.exp(-tau * 4) : 0;
      const sx = Math.sin(t * 0.55) * 0.42;
      s.moeda.rotation.y += ((sx + alvo.x * 0.5 + giro + balanco) - s.moeda.rotation.y) * Math.min(1, dt * (giroVel ? 30 : 4));
      s.moeda.rotation.x += ((-alvo.y * 0.3) - s.moeda.rotation.x) * Math.min(1, dt * 4);
      s.moeda.position.y = Math.sin(t * 1.1) * 0.09;
      s.chao.material.uniforms.uT.value = t * 0.35;
      const a = s.pos;
      for (let i = 1; i < a.length; i += 3) { a[i] += dt * 0.18; if (a[i] > 6.6) a[i] = -2.4; }
      s.poeira.geometry.attributes.position.needsUpdate = true;
      cam.position.z = 8 - zoom * 2.2;
      cam.lookAt(0, 0.1, 0);
    },
  });
  if (!p) return null;

  addEventListener('pointermove', (e) => {
    alvo.x = (e.clientX / innerWidth) * 2 - 1;
    alvo.y = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });
  addEventListener('deviceorientation', (e) => {
    if (e.gamma == null) return;
    alvo.x = Math.max(-1, Math.min(1, e.gamma / 30));
    alvo.y = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
  }, { passive: true });

  return {
    // Senha certa: um giro rápido e um passo da câmera para dentro.
    entrar() {
      giroVel = 26;
      const ini = performance.now();
      const anim = () => { zoom = Math.min(1, (performance.now() - ini) / 420); if (zoom < 1) requestAnimationFrame(anim); };
      anim();
    },
    // Senha errada: a moeda balança de lado.
    negar() { tremor = performance.now() / 1000; },
  };
}

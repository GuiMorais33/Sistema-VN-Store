// Palco 3D compartilhado: cria o renderer dentro de um elemento e cuida do
// que faz uma cena pesar ou travar — só desenha quando está visível na tela,
// para quando a aba some, limita a resolução e respeita "reduzir movimento".
// Se o aparelho não tiver WebGL, devolve null e a página segue sem 3D.
import * as T from '/vendor/three-vn.min.js';

export { T };

export function palco(el, { setup, frame, camera = {}, dprMax = 1.75 }) {
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (_) { return null; }
  if (!renderer.getContext()) return null;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprMax));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const cv = renderer.domElement;
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
  el.appendChild(cv);

  const scene = new T.Scene();
  const cam = new T.PerspectiveCamera(camera.fov || 40, 1, 0.1, 100);
  cam.position.set(...(camera.pos || [0, 0, 7]));

  const parado = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx = { T, scene, cam, renderer, el, parado, w: 1, h: 1, aspect: 1 };
  const api = setup(ctx) || {};
  ctx.s = api;   // o que o setup devolveu fica à mão no frame

  const medir = () => {
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    Object.assign(ctx, { w, h, aspect: w / h });
    renderer.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
    api.resize?.(ctx);
    if (!rodando) desenhar(0);
  };

  let visivel = true, rodando = false, raf = 0, t0 = performance.now(), ultimo = t0;
  const desenhar = (dt) => { frame?.(ctx, (performance.now() - t0) / 1000, dt); renderer.render(scene, cam); };
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - ultimo) / 1000); ultimo = now;
    desenhar(dt);
  };
  const atualizar = () => {
    const deve = visivel && !document.hidden && !parado;
    if (deve && !rodando) { rodando = true; ultimo = performance.now(); raf = requestAnimationFrame(loop); }
    else if (!deve && rodando) { rodando = false; cancelAnimationFrame(raf); }
  };

  new ResizeObserver(medir).observe(el);
  new IntersectionObserver(([e]) => { visivel = e.isIntersecting; atualizar(); }).observe(el);
  document.addEventListener('visibilitychange', atualizar);
  medir();
  requestAnimationFrame(() => { el.classList.add('fx-on'); atualizar(); if (parado) desenhar(0); });

  return Object.assign(api, { ctx, desenhar: () => desenhar(0) });
}

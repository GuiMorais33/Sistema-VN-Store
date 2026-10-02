// O pulso da loja, no cartão do Maestro: um campo de pontos que ondula.
// A altura das ondas acompanha o dia — quanto mais o vendido de hoje passa
// da média dos últimos dias, mais o campo se agita. Dia parado, mar calmo.
import { palco, T } from '/fx/palco.js';

export function montarPulso(el) {
  let alvo = 0.25, amp = 0.25;
  const p = palco(el, {
    camera: { fov: 36, pos: [0, 3.4, 7.2] },
    dprMax: 1.5,
    setup({ scene, cam }) {
      cam.lookAt(0, 0, -0.6);
      const CX = 96, CZ = 44, pos = new Float32Array(CX * CZ * 3);
      let i = 0;
      for (let z = 0; z < CZ; z++) for (let x = 0; x < CX; x++) {
        pos[i++] = (x / (CX - 1) - 0.5) * 15;
        pos[i++] = 0;
        pos[i++] = (z / (CZ - 1) - 0.5) * 7;
      }
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      const mat = new T.ShaderMaterial({
        transparent: true, depthWrite: false, blending: T.AdditiveBlending,
        uniforms: {
          uT: { value: 0 }, uAmp: { value: amp },
          uPx: { value: Math.min(devicePixelRatio || 1, 1.5) },
          uA: { value: new T.Color(0x178a31) }, uB: { value: new T.Color(0x9dffb2) },
        },
        vertexShader: `
          uniform float uT, uAmp, uPx; varying float vH; varying float vF;
          void main(){
            vec3 p = position;
            float w = sin(p.x*0.75 + uT*1.1) * 0.55
                    + sin(p.z*1.3 - uT*0.8 + p.x*0.25) * 0.35
                    + sin(length(p.xz - vec2(3.5,0.0))*1.6 - uT*2.0) * 0.30;
            p.y = w * uAmp;
            vH = w * 0.5 + 0.5;
            vec4 mv = modelViewMatrix * vec4(p,1.0);
            vF = smoothstep(14.0, 5.5, -mv.z);
            gl_PointSize = (1.4 + vH * 1.6) * uPx * (7.0 / -mv.z);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform vec3 uA, uB; varying float vH; varying float vF;
          void main(){
            float d = length(gl_PointCoord - 0.5);
            if (d > 0.5) discard;
            float a = smoothstep(0.5, 0.1, d) * vF * (0.35 + vH * 0.65);
            gl_FragColor = vec4(mix(uA, uB, vH), a);
          }`,
      });
      scene.add(new T.Points(geo, mat));
      return { mat };
    },
    frame({ s }, t, dt) {
      amp += (alvo - amp) * Math.min(1, dt * 1.5);
      s.mat.uniforms.uT.value = t * (0.55 + amp * 0.6);
      s.mat.uniforms.uAmp.value = amp;
    },
  });
  if (!p) return null;
  return {
    // força de 0 (nada vendido) a 1 (dia bem acima da média)
    set(forca) {
      alvo = 0.12 + Math.max(0, Math.min(1, forca)) * 0.78;
      if (p.ctx.parado) { amp = alvo; p.ctx.s.mat.uniforms.uAmp.value = amp; p.desenhar(); }
    },
  };
}

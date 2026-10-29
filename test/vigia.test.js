// Para usar no dia a dia, o que não pode acontecer de jeito nenhum:
//  - a resposta da loja se perde depois de gravar e a mesma venda baixa
//    duas vezes;
//  - uma conversa travada com a loja parar o motor para sempre (em
//    outubro ficou 3 semanas parado sem ninguém ver);
//  - venda daqui sem baixar na loja, ou motor parado, sem alarme no Início.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Nuvemshop de mentira com defeitos sob encomenda.
function loja(cfg) {
  const st = { estoque: 5, perderRespostas: 0, travarPedidos: 0, recusarGravar: false, ...cfg };
  const produto = () => ({ id: 100, name: { pt: 'Camiseta' }, description: { pt: '' }, published: true, categories: [], images: [],
    variants: [{ id: 1001, values: [{ pt: 'M' }], price: '100.00', sku: '', stock: st.estoque, stock_management: true }] });
  const srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const [, recurso, pid, sub] = url.pathname.split('/').filter(Boolean);
      const json = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      if (recurso === 'products' && !pid) return json(200, url.searchParams.get('page') === '1' ? [produto()] : []);
      if (recurso === 'products' && sub === 'variants') {
        if (req.method === 'GET') return json(200, produto().variants[0]);
        if (st.recusarGravar) return json(503, { description: 'fora do ar' });
        st.estoque = JSON.parse(corpo).stock;       // a loja GRAVA...
        if (st.perderRespostas > 0) { st.perderRespostas -= 1; return req.socket.destroy(); }   // ...e a resposta se perde
        return json(200, produto().variants[0]);
      }
      if (recurso === 'orders' && st.travarPedidos > 0) { st.travarPedidos -= 1; return; }   // nunca responde
      return json(200, []);
    });
  });
  return { srv, st };
}

const ligados = [];
after(() => ligados.forEach((x) => { x.s?.parar(); x.srv.close(); }));
async function subir(cfg, env = {}) {
  const { srv, st } = loja(cfg);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const s = await subirServidor({ NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'x',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${srv.address().port}`, NUVEMSHOP_ESPERAS_MS: '20,40', ...env });
  ligados.push({ s, srv });
  await s.pedir('POST', '/api/sync', { corpo: {} });
  const vid = s.banco().prepare("SELECT id FROM variants WHERE nuvemshop_variant_id = '1001'").get().id;
  const vender = () => s.pedir('POST', '/api/sales', { corpo: { items: [{ variant_id: vid, qty: 1 }], payment_method: 'Pix' } });
  const local = () => s.banco().prepare('SELECT stock, ns_delta FROM variants WHERE id = ?').get(vid);
  return { s, st, vender, local };
}

test('a loja grava e a resposta se perde: a venda NÃO baixa duas vezes', async () => {
  const { st, vender, local } = await subir({ estoque: 5, perderRespostas: 1 });
  await vender();                          // loja foi a 4, mas o sistema não soube
  assert.equal(st.estoque, 4);
  assert.equal(local().ns_delta, -1);      // continua na fila
  await vender();                          // segunda venda da mesma peça
  assert.equal(st.estoque, 3);             // 5 − 2 vendas (sem a conferência, iria a 2)
  assert.deepEqual(local(), { stock: 3, ns_delta: 0 });
});

test('conversa travada com a loja: o vigia abandona a volta e o motor segue', async () => {
  const { s } = await subir({ travarPedidos: 1 },
    { PRIMEIRA_RODADA_MS: '100', SYNC_INTERVALO_MS: '300', LIMITE_VOLTA_MS: '700', NUVEMSHOP_TIMEOUT_MS: '60000' });
  let a;
  for (let i = 0; i < 60; i++) {
    a = (await s.pedir('GET', '/api/connection')).json.automatico;
    if (a.pedidos.ultima) break;
    await espera(100);
  }
  assert.ok(a.travou_em, 'o vigia anotou que a volta travou');
  assert.ok(a.pedidos.ultima, 'e a volta seguinte leu os pedidos');
});

test('motor parado: alarme vermelho no Início', async () => {
  const { s } = await subir({ travarPedidos: 999 },
    { PRIMEIRA_RODADA_MS: '100', SYNC_INTERVALO_MS: '200', LIMITE_VOLTA_MS: '300', NUVEMSHOP_TIMEOUT_MS: '60000', ALERTA_CARENCIA_MS: '500' });
  await espera(1200);
  const al = (await s.pedir('GET', '/api/operacao')).json.alertas;
  assert.ok(al.some((x) => x.tipo === 'motor' && x.nivel === 'crit'));
});

test('venda daqui sem baixar na loja: alarme no Início até subir', async () => {
  const { s, st, vender } = await subir({ estoque: 5, recusarGravar: true },
    { PRIMEIRA_RODADA_MS: '100', SYNC_INTERVALO_MS: '250', ALERTA_PENDENTE_MS: '300' });
  await vender();
  let al = [];
  for (let i = 0; i < 30 && !al.some((x) => x.tipo === 'estoque'); i++) { await espera(150); al = (await s.pedir('GET', '/api/operacao')).json.alertas; }
  assert.ok(al.some((x) => x.tipo === 'estoque'), 'avisou');
  st.recusarGravar = false;                // a loja voltou
  for (let i = 0; i < 30 && al.some((x) => x.tipo === 'estoque'); i++) { await espera(150); al = (await s.pedir('GET', '/api/operacao')).json.alertas; }
  assert.ok(!al.some((x) => x.tipo === 'estoque'), 'o alarme some quando sobe');
  assert.equal(st.estoque, 4);
});

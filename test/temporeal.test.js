// "Tempo real" com a Nuvemshop, no que importa para o balcão:
//  - o site vendeu a última peça e o balcão vende a mesma logo depois: o
//    PDV avisa na hora (e fica lembrete), e a loja não vai para negativo;
//  - pedido de hoje chega em ~2 min, sem esperar a leitura dos 45 dias;
//  - ler os clientes da loja (lento) não segura os pedidos do site.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);   // fuso da loja (−03:00)

function loja(cfg = {}) {
  const st = { estoque: 1, pedidos: [], clientes: [], demoraClientes: 0, pedidosLidos: [], clientesLidos: [], ...cfg };
  const produto = () => ({ id: 100, name: { pt: 'Boné' }, description: { pt: '' }, published: true, categories: [], images: [],
    variants: [{ id: 1001, values: [{ pt: 'U' }], price: '100.00', sku: '', stock: st.estoque, stock_management: true }] });
  const srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const [, recurso, pid, sub] = url.pathname.split('/').filter(Boolean);
      const json = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      const pg1 = url.searchParams.get('page') === '1';
      if (recurso === 'products' && !pid) return json(pg1 ? [produto()] : []);
      if (recurso === 'products' && sub === 'variants') {
        if (req.method === 'PUT') st.estoque = JSON.parse(corpo).stock;
        return json(produto().variants[0]);
      }
      if (recurso === 'orders') {
        if (pg1) st.pedidosLidos.push(url.searchParams.get('created_at_min'));
        const min = url.searchParams.get('created_at_min');
        return json(pg1 ? st.pedidos.filter((o) => !min || o.created_at >= new Date(min).toISOString()) : []);
      }
      if (recurso === 'customers') {
        if (pg1) st.clientesLidos.push(url.searchParams.get('created_at_min'));
        return setTimeout(() => json(pg1 ? st.clientes : []), st.demoraClientes);
      }
      return json([]);
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
  return { s, st };
}
const pedido = (n, quando = new Date()) => ({ id: 9000 + n, number: 9000 + n, created_at: quando.toISOString(), status: 'open',
  payment_status: 'paid', shipping_status: 'unpacked', total: '100.00', gateway: 'pix', storefront: 'store',
  products: [{ product_id: 100, variant_id: 1001, quantity: 1, price: '100.00', name: 'Boné (U)' }] });

test('o site vendeu a última e o balcão vende a mesma: o PDV avisa na hora', async () => {
  const { s, st } = await subir({ estoque: 1 });
  await s.pedir('POST', '/api/sync', { corpo: {} });
  const vid = s.banco().prepare("SELECT id FROM variants WHERE nuvemshop_variant_id = '1001'").get().id;
  st.estoque = 0;   // o site vendeu; aqui ainda mostra 1 (o pedido não foi lido)
  const r = await s.pedir('POST', '/api/sales', { corpo: { items: [{ variant_id: vid, qty: 1 }], payment_method: 'Pix' } });
  assert.equal(r.status, 200, String(r.bytes));
  assert.deepEqual(r.json.conflitos, [{ nome: 'Boné U', faltou: 1, na_loja: 0 }]);
  assert.equal(st.estoque, 0);                           // a loja não vai para −1
  const lembrete = s.banco().prepare("SELECT title, notes FROM reminders WHERE title LIKE 'Conferir pedidos do site%'").get();
  assert.ok(lembrete, 'ficou lembrete');
  assert.match(lembrete.notes, new RegExp(r.json.code));

  // Venda normal (a loja tinha a peça) não avisa nada.
  st.estoque = 3;
  await s.pedir('POST', '/api/sync', { corpo: {} });
  const ok = await s.pedir('POST', '/api/sales', { corpo: { items: [{ variant_id: vid, qty: 1 }], payment_method: 'Pix' } });
  assert.deepEqual(ok.json.conflitos, []);
  assert.equal(st.estoque, 2);
  // Cancelar devolve peça: nunca é "faltou".
  const id = s.banco().prepare('SELECT id FROM sales WHERE code = ?').get(ok.json.code).id;
  await s.pedir('POST', `/api/sales/${id}/cancelar`, { corpo: { motivo: 'teste', forma: 'Pix' } });
  assert.equal(st.estoque, 3);
  assert.equal(s.banco().prepare("SELECT COUNT(*) n FROM reminders WHERE title LIKE 'Conferir pedidos do site%'").get().n, 1);
});

test('pedido de hoje chega na volta rápida, sem esperar a leitura dos 45 dias', async () => {
  const { s, st } = await subir({ estoque: 5 },
    { PRIMEIRA_RODADA_MS: '100', SYNC_INTERVALO_MS: '600000', PEDIDOS_RAPIDO_MS: '250' });
  // Primeira volta: lê os 45 dias (e o histórico). O pedido só entra
  // depois que ela termina — assim ele só pode chegar pela volta rápida.
  for (let i = 0; i < 80 && !(await s.pedir('GET', '/api/connection')).json.automatico.ultima_volta; i++) await espera(50);
  const lidasNaPrimeira = st.pedidosLidos.length;
  st.pedidos.push(pedido(1));
  let venda;
  for (let i = 0; i < 40 && !venda; i++) {
    await espera(100);
    venda = s.banco().prepare("SELECT code FROM sales WHERE code = 'SITE-9001'").get();
  }
  assert.ok(venda, 'o pedido de hoje chegou sem esperar os 10 min');
  // A primeira volta lê os 45 dias e, uma vez só, o histórico de 2 anos.
  // Depois dela, até a próxima volta cheia (10 min), só o dia de hoje — então
  // o pedido chegou por uma leitura rápida.
  const [cheia, historico, ...rapidas] = st.pedidosLidos;
  const txt = JSON.stringify(st.pedidosLidos);
  assert.notEqual(cheia.slice(0, 10), hoje(), txt);
  assert.notEqual(historico.slice(0, 10), hoje(), txt);
  assert.ok(rapidas.length >= 1 && st.pedidosLidos.length > lidasNaPrimeira, txt);
  assert.ok(rapidas.every((d) => d.slice(0, 10) === hoje()), txt);
});

test('ler os clientes da loja (lento) não segura os pedidos; depois lê só os novos', async () => {
  const { s, st } = await subir({ estoque: 5, demoraClientes: 1500, clientes: [{ id: 501, name: 'Ana Souza', email: 'ana@x.com' }] },
    { PRIMEIRA_RODADA_MS: '100', SYNC_INTERVALO_MS: '600000', PEDIDOS_RAPIDO_MS: '200', RELER_CLIENTES_MS: '1000' });
  for (let i = 0; i < 40 && !st.clientesLidos.length; i++) await espera(50);
  const lidosAntes = st.pedidosLidos.length;
  await espera(900);   // os clientes ainda estão chegando (1,5 s)...
  assert.ok(st.pedidosLidos.length >= lidosAntes + 2, `os pedidos seguiram: ${lidosAntes} → ${st.pedidosLidos.length}`);
  const a = (await s.pedir('GET', '/api/connection')).json.automatico;
  assert.equal(a.travou_em, null);
  // ...chegam, e a próxima leitura pede só quem se cadastrou de dois dias para cá.
  for (let i = 0; i < 60 && st.clientesLidos.length < 2; i++) await espera(100);
  assert.equal(st.clientesLidos[0], null);
  assert.ok(st.clientesLidos[1], 'a segunda leitura tem filtro de data');
  assert.ok(st.clientesLidos[1].slice(0, 10) < hoje());
  assert.equal(s.banco().prepare("SELECT COUNT(*) n FROM customers WHERE nuvemshop_customer_id = '501'").get().n, 1);
});

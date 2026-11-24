// Financeiro → Vendas: todas as vendas do período (PDV e site) para abrir,
// conferir, fazer as contas e corrigir. Cada venda traz o dinheiro que
// entrou por ela, o lucro (sem o frete), a comissão e o histórico; a marca
// de "conferida" sai sozinha quando a venda muda depois.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const SENHA = 'senha-do-dono';
const loja = {
  produtos: [
    { id: 100, nome: 'Camiseta Nike', preco: '100.00', estoque: 8 },
    { id: 200, nome: 'Boné Lacoste', preco: '50.00', estoque: 6 },
  ],
  pedidos: [{ id: 9001, number: 9001, created_at: new Date().toISOString(), status: 'open', payment_status: 'paid',
    shipping_status: 'unpacked', gateway: 'pix', gateway_name: 'Pix', storefront: 'store', customer: { id: 77, name: 'Carla Dias' },
    subtotal: '200.00', discount: '20.00', discount_coupon: '20.00', discount_gateway: '0.00', shipping_cost_customer: '25.00',
    shipping_cost_owner: '25.00', total: '205.00', coupon: [{ code: 'BLACK10' }], shipping_option: { name: 'Correios PAC' },
    products: [{ product_id: 100, variant_id: 1001, quantity: 2, price: '100.00', name: 'Camiseta Nike' }] }],
};
const comoLoja = (p) => ({ id: p.id, name: { pt: p.nome }, description: { pt: '' }, published: true, categories: [], images: [],
  variants: [{ id: p.id * 10 + 1, values: [], price: p.preco, promotional_price: null, sku: '', stock: p.estoque, stock_management: true }] });

let srv, s, dono, ana, sessaoAna;
const cookieDe = (r, nome) => r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(nome + '=') && c.length > nome.length + 1);
const pedir = (m, c, corpo, ck = dono) => s.pedir(m, c, { corpo, headers: { Cookie: ck } });
const vid = (ns) => s.banco().prepare('SELECT id FROM variants WHERE nuvemshop_variant_id = ?').get(String(ns)).id;
const vender = async (corpo) => { const r = await pedir('POST', '/api/sales', corpo); assert.equal(r.status, 200, String(r.bytes)); return r.json; };
const idDe = (code) => s.banco().prepare('SELECT id FROM sales WHERE code = ?').get(code).id;
const lista = async () => { const r = await pedir('GET', '/api/vendas/conferencia'); assert.equal(r.status, 200, String(r.bytes)); return r.json; };
const naLista = async (code) => (await lista()).vendas.find((v) => v.code === code);

before(async () => {
  srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const [, recurso, pid, sub] = url.pathname.split('/').filter(Boolean);
      const json = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
      const pg1 = url.searchParams.get('page') === '1';
      const p = pid && loja.produtos.find((x) => String(x.id) === pid);
      if (recurso === 'products' && !pid) return json(pg1 ? loja.produtos.map(comoLoja) : []);
      if (recurso === 'products' && p && sub === 'variants') {
        if (req.method === 'PUT') p.estoque = JSON.parse(corpo).stock;
        return json(comoLoja(p).variants[0]);
      }
      if (recurso === 'products' && p) return json(comoLoja(p));
      if (recurso === 'orders') return json(pg1 ? loja.pedidos : []);
      return json([]);
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  s = await subirServidor({ APP_PASSWORD: SENHA, NUVEMSHOP_STORE_ID: '123', NUVEMSHOP_ACCESS_TOKEN: 'x',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${srv.address().port}` });
  dono = cookieDe(await s.pedir('POST', '/api/login', { corpo: { password: SENHA } }), 'vn_auth');
  await pedir('POST', '/api/sync', {});
  // Custo das peças: a camiseta custa 40, o boné fica sem custo.
  assert.equal((await pedir('POST', '/api/custos', { itens: [{ variant_id: vid(1001), cost: 40 }] })).status, 200);
  ana = (await pedir('POST', '/api/team', { name: 'Ana Souza', pin: '2468', commission_pct: 5 })).json.membro;
  sessaoAna = cookieDe(await s.pedir('POST', '/api/login/vendedor', { corpo: { id: ana.id, pin: '2468' } }), 'vn_vend');
  await pedir('POST', '/api/import-customers', { days: 5 });
});
after(() => { s?.parar(); srv?.close(); });

test('a lista traz todas as vendas do período, com as contas de cada uma', async () => {
  const paga = await vender({ items: [{ variant_id: vid(1001), qty: 1 }], payment_method: 'Pix', discount: 10, seller_id: ana.id });
  const fiado = await vender({ items: [{ variant_id: vid(2001), qty: 1 }], payment_status: 'pendente', new_customer: { name: 'Rui Alves' } });
  const canc = await vender({ items: [{ variant_id: vid(2001), qty: 1 }], payment_method: 'Dinheiro' });
  await pedir('POST', `/api/sales/${idDe(canc.code)}/cancelar`, { motivo: 'desistiu', forma: 'Dinheiro' });

  const d = await lista();
  const v = (c) => d.vendas.find((x) => x.code === c);
  // Venda paga: 100 − 10 de desconto = 90; custo 40 → lucro 50; entrou 90.
  assert.equal(v(paga.code).total, 90);
  assert.equal(v(paga.code).desconto, 10);
  assert.equal(v(paga.code).lucro, 50);
  assert.equal(v(paga.code).no_caixa, 90);
  assert.equal(v(paga.code).conta, 1);
  assert.equal(v(paga.code).seller_name, 'Ana Souza');
  assert.equal(v(paga.code).pecas, 'Camiseta Nike Único');
  // Fiado: conta como venda, é a receber, nada no caixa; boné sem custo.
  assert.equal(v(fiado.code).fiado, 1);
  assert.equal(v(fiado.code).no_caixa, 0);
  assert.equal(v(fiado.code).sem_custo, 1);
  // Cancelada: fora da conta, o estorno zera o caixa.
  assert.equal(v(canc.code).conta, 0);
  assert.equal(v(canc.code).no_caixa, 0);
  assert.equal(v(canc.code).lucro, 0);
  // Pedido do site: frete fora do lucro, cupom e desconto do pedido.
  const site = v('SITE-9001');
  assert.equal(site.total, 205);
  assert.equal(site.frete, 25);
  assert.equal(site.desconto, 20);
  assert.equal(site.cupom, 'BLACK10');
  assert.equal(site.lucro, 205 - 25 - 80);
  assert.equal(site.no_caixa, 205);
  assert.equal(d.de.slice(0, 8) + '01', d.de);   // padrão: este mês
});

test('a venda aberta: dinheiro, lucro, comissão e o pedido do site inteiro', async () => {
  const code = (await lista()).vendas.find((x) => x.seller_name === 'Ana Souza').code;
  const v = (await pedir('GET', `/api/vendas/${idDe(code)}`)).json;
  assert.equal(v.no_caixa, 90);
  assert.equal(v.entradas.length, 1);
  assert.equal(v.lucro, 50);
  assert.deepEqual([v.comissao.pct, v.comissao.valor], [5, 4.5]);   // 5% de 90
  assert.ok(v.estoque.some((m) => m.delta === -1 && m.reason === 'venda_pdv'));
  const site = (await pedir('GET', `/api/vendas/${idDe('SITE-9001')}`)).json;
  assert.equal(site.ns.frete_cliente, 25);
  assert.equal(site.ns.envio, 'Correios PAC');
  assert.deepEqual(site.ns.cupons, ['BLACK10']);
  assert.equal(site.comissao.valor, 0);
  assert.match(site.comissao.porque, /site/);
});

test('conferir em lote; editar tira a marca e fica no histórico', async () => {
  const d = await lista();
  const ids = d.vendas.filter((v) => v.conta).map((v) => v.id);
  const r = await pedir('POST', '/api/vendas/conferir', { ids });
  assert.equal(r.json.alteradas, ids.length);
  assert.ok((await lista()).vendas.filter((v) => v.conta).every((v) => v.conferida_em));
  // Conferir de novo não muda nada (nem duplica o histórico).
  assert.equal((await pedir('POST', '/api/vendas/conferir', { ids })).json.alteradas, 0);

  const paga = d.vendas.find((v) => v.seller_name === 'Ana Souza');
  const e = await pedir('PUT', `/api/sales/${paga.id}`, { items: [{ variant_id: vid(1001), qty: 1, unit_price: 80 }],
    discount: 0, payment_method: 'Crédito' });
  assert.equal(e.status, 200, String(e.bytes));
  const depois = await naLista(paga.code);
  assert.equal(depois.conferida_em, null);
  assert.equal(depois.editada, 1);
  assert.equal(depois.total, 80);
  const v = (await pedir('GET', `/api/vendas/${paga.id}`)).json;
  const ed = v.historico.find((h) => h.tipo === 'edicao');
  assert.match(ed.texto, /Camiseta Nike Único: R\$ 100,00 → R\$ 80,00/);
  assert.match(ed.texto, /forma Pix → Crédito/);
  assert.match(ed.texto, /total R\$ 90,00 → R\$ 80,00/);
  assert.equal(ed.quem, 'dono');
  assert.ok(v.historico.some((h) => h.tipo === 'conferida' && /Confira de novo/.test(h.texto)));
  // As outras continuam conferidas.
  assert.ok((await naLista('SITE-9001')).conferida_em);
});

test('fiado recebido e troca de vendedor ficam no histórico', async () => {
  const fiado = (await lista()).vendas.find((v) => v.fiado);
  await pedir('POST', `/api/sales/${fiado.id}/settle`, { payment_method: 'Pix' });
  await pedir('POST', `/api/sales/${fiado.id}/vendedor`, { seller_id: ana.id, canal: 'whatsapp' });
  const v = (await pedir('GET', `/api/vendas/${fiado.id}`)).json;
  const textos = v.historico.map((h) => h.texto);
  assert.ok(textos.some((t) => /fiado recebido: R\$ 50,00 em Pix/.test(t)));
  assert.ok(textos.some((t) => /vendedor loja → Ana Souza/.test(t)));
  assert.ok(textos.some((t) => /balcão → WhatsApp/.test(t)));
  assert.equal(v.no_caixa, 50);
  assert.match(v.comissao.porque, /internet/);   // WhatsApp não gera comissão
});

test('observação do dono: fica na venda e a leitura da loja não apaga', async () => {
  const id = idDe('SITE-9001');
  assert.equal((await pedir('POST', `/api/sales/${id}/obs`, { obs: 'cliente pediu embrulho' })).status, 200);
  await pedir('POST', '/api/import-customers', { days: 5 });
  assert.equal((await naLista('SITE-9001')).obs, 'cliente pediu embrulho');
  // O pedido mudou de valor na loja depois de conferido: a marca sai.
  loja.pedidos[0].total = '215.00';
  await pedir('POST', '/api/import-customers', { days: 5 });
  const v = await naLista('SITE-9001');
  assert.equal(v.conferida_em, null);
  assert.equal(v.total, 215);
});

test('o período escolhido e o que o vendedor não vê', async () => {
  const ontem = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 864e5));
  const d = (await pedir('GET', `/api/vendas/conferencia?de=${ontem}&ate=${ontem}`)).json;
  assert.equal(d.de, ontem);
  assert.equal(d.vendas.length, 0);
  // Vendedor: a lista do Financeiro, conferir e observação são do dono;
  // a venda aberta vem sem custo, lucro e dinheiro.
  assert.equal((await pedir('GET', '/api/vendas/conferencia', null, sessaoAna)).status, 403);
  assert.equal((await pedir('POST', '/api/vendas/conferir', { ids: [1] }, sessaoAna)).status, 403);
  assert.equal((await pedir('POST', `/api/sales/${idDe('SITE-9001')}/obs`, { obs: 'x' }, sessaoAna)).status, 403);
  const code = (await lista()).vendas.find((x) => x.seller_name === 'Ana Souza' && x.channel === 'pdv').code;
  const v = (await pedir('GET', `/api/vendas/${idDe(code)}`, null, sessaoAna)).json;
  assert.ok(v.itens.length);
  assert.ok(v.itens.every((i) => !('unit_cost' in i)));
  for (const k of ['cost_total', 'margin', 'lucro', 'entradas', 'comissao', 'historico', 'obs']) assert.ok(!(k in v), k);
});

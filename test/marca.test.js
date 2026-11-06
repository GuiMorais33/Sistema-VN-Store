// Marca errada no cadastro da loja (boné Adidas marcado como Lacoste): a
// troca mexe SÓ nas categorias de marca do produto na Nuvemshop — foto,
// preço, estoque, descrição e as outras categorias ficam como estão.
// E salvar o produto pela tela não pode tirar ele das outras categorias do
// site nem mandar a foto dele de novo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const CATS = [
  { id: 1, name: { pt: 'MARCAS' }, parent: 0 },
  { id: 2, name: { pt: 'Lacoste' }, parent: 1 },
  { id: 3, name: { pt: 'Adidas' }, parent: 1 },
  { id: 4, name: { pt: 'Nike' }, parent: 1 },
  { id: 10, name: { pt: 'Bonés' }, parent: 0 },
  { id: 11, name: { pt: 'Coleção Verão' }, parent: 0 },
  { id: 12, name: { pt: 'Acessórios' }, parent: 0 },
];
const catObj = (id) => ({ ...CATS.find((c) => c.id === id) });
const loja = {
  produtos: [
    { id: 500, nome: 'Boné Adidas', cats: [1, 2, 10, 11], estoque: 3 },          // marcado como Lacoste
    { id: 600, nome: 'Boné Adidas Letreiro', cats: [1, 2, 3, 10], estoque: 2 },  // em duas marcas
    { id: 700, nome: 'Boné Nike', cats: [1, 4, 10, 11], estoque: 1 },            // certo
  ],
  puts: [], fotos: 0,
};
const comoLoja = (p) => ({ id: p.id, name: { pt: p.nome }, description: { pt: 'desc' }, published: true,
  categories: p.cats.map(catObj), images: [{ id: p.id * 10, src: `https://cdn.exemplo/${p.id}.jpg` }],
  variants: [{ id: p.id * 10 + 1, values: [], price: '99.90', sku: '', stock: p.estoque, stock_management: true }] });

let srv, s;
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
      if (recurso === 'categories') return json(pg1 ? CATS : []);
      if (recurso === 'products' && !pid) return json(pg1 ? loja.produtos.map(comoLoja) : []);
      if (recurso === 'products' && p && sub === 'images') { loja.fotos += 1; return json({ id: 999 }); }
      if (recurso === 'products' && p && sub === 'variants') {
        if (req.method === 'PUT') p.estoque = JSON.parse(corpo).stock;
        return json(comoLoja(p).variants[0]);
      }
      if (recurso === 'products' && p) {
        if (req.method === 'PUT') {
          const b = JSON.parse(corpo);
          loja.puts.push({ id: p.id, corpo: b });
          if (Array.isArray(b.categories)) p.cats = b.categories;
        }
        return json(comoLoja(p));
      }
      return json([]);
    });
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  s = await subirServidor({ NUVEMSHOP_STORE_ID: '123', NUVEMSHOP_ACCESS_TOKEN: 'x',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${srv.address().port}` });
  await s.pedir('POST', '/api/sync', { corpo: {} });
});
after(() => { s?.parar(); srv?.close(); });

const local = (nsId) => s.banco().prepare('SELECT * FROM products WHERE nuvemshop_product_id = ?').get(String(nsId));
const trocar = (nsId, marca) => s.pedir('POST', `/api/catalog/${local(nsId).id}/marca`, { corpo: { marca } });
const mesmas = (a, b) => assert.deepEqual([...a].sort((x, y) => x - y), [...b].sort((x, y) => x - y));

test('o cadastro veio com a marca errada', () => {
  assert.equal(local(500).brand, 'Lacoste');
});

test('troca a marca: só as categorias de marca mudam na loja', async () => {
  loja.puts = [];
  const r = await trocar(500, 'adidas');
  assert.equal(r.status, 200, String(r.bytes));
  assert.equal(r.json.marca, 'Adidas');
  assert.deepEqual(r.json.antes, ['Lacoste']);
  // Um PUT só, só com as categorias: nada de foto, preço, estoque, descrição.
  assert.equal(loja.puts.length, 1);
  assert.deepEqual(Object.keys(loja.puts[0].corpo), ['categories']);
  mesmas(loja.produtos[0].cats, [1, 3, 10, 11]);   // saiu Lacoste, entrou Adidas; Bonés e Coleção Verão ficaram
  assert.equal(local(500).brand, 'Adidas');
  assert.equal(loja.produtos[0].estoque, 3);
  // A releitura da loja confirma (não volta para Lacoste).
  await s.pedir('POST', '/api/sync', { corpo: {} });
  assert.equal(local(500).brand, 'Adidas');
});

test('produto em duas marcas fica só na certa', async () => {
  const r = await trocar(600, 'Adidas');
  assert.equal(r.status, 200);
  mesmas(loja.produtos[1].cats, [1, 3, 10]);
});

test('já está certo: não mexe na loja', async () => {
  loja.puts = [];
  const r = await trocar(700, 'Nike');
  assert.equal(r.json.ja_estava, true);
  assert.equal(loja.puts.length, 0);
});

test('marca que não existe na loja: não cria, diz quais existem', async () => {
  loja.puts = [];
  const r = await trocar(700, 'Adidaz');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Adidas, Lacoste, Nike/);
  assert.equal(loja.puts.length, 0);
});

test('salvar o produto pela tela não tira ele das outras categorias nem duplica a foto', async () => {
  loja.puts = []; loja.fotos = 0;
  const id = local(700).id;
  const prod = (await s.pedir('GET', `/api/catalog/${id}`)).json;
  const r = await s.pedir('PUT', `/api/catalog/${id}`, { corpo: { name: prod.name, brand: prod.brand, category: prod.category,
    variants: prod.variants.map((v) => ({ ...v, price: 109.9 })) } });
  assert.equal(r.status, 200, String(r.bytes));
  assert.equal(r.json.sync.ok, true, JSON.stringify(r.json.sync));
  mesmas(loja.produtos[2].cats, [1, 4, 10, 11]);   // "Coleção Verão" continua
  assert.equal(loja.fotos, 0, 'a foto que veio da loja não sobe de novo');

  // Trocou a categoria principal: a antiga sai, as outras ficam.
  await s.pedir('PUT', `/api/catalog/${id}`, { corpo: { category: 'Acessórios' } });
  mesmas(loja.produtos[2].cats, [1, 4, 11, 12]);
});

// A busca do PDV tem que achar do jeito que o balcão digita, não só o nome
// exato do cadastro. Produtos com nomes no formato dos da loja.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { subirServidor } from './servidor.js';

let s;
const PRODUTOS = [
  ['Boné Lacoste Miami Open 2026', 'Lacoste', 'Bonés', ['Único']],
  ['Boné Lacoste Sport 26', 'Lacoste', 'Bonés', ['Único']],
  ['Tênis Nike Dunk Low', 'Nike', 'Tênis', ['39', '40', '41', '42']],
  ['Tênis Nike Air Force 1', 'Nike', 'Tênis', ['40', '42']],
  ['Tênis Mizuno Pro 13', 'Mizuno', 'Tênis', ['41', '42']],
  ['Tênis New Balance 530', 'New Balance', 'Tênis', ['41']],
  ['Camiseta Nike', 'Nike', 'Camisetas', ['P', 'M', 'G', 'GG']],
  ['Camiseta Louis Vuitton', 'Louis Vuitton', 'Camisetas', ['M', 'G']],
  ['Camisa Polo Tommy Hilfiger', 'Tommy Hilfiger', 'Camisa Polo', ['M', 'G']],
  ['Conjunto Moletom Nike', 'Nike', 'Moletons', ['M', 'G']],
  ['Bermuda Beachwear Lacoste Miami Open', 'Lacoste', 'Bermudas Beachwear', ['M', 'G']],
  ['Chinelo Prada', 'Prada', 'Chinelos', ['39', '40']],
  ['Óculos Ray-Ban', 'Ray-Ban', 'Óculos', ['Único']],
];

before(async () => {
  s = await subirServidor();
  for (const [name, brand, category, tamanhos] of PRODUTOS) {
    const r = await s.pedir('POST', '/api/catalog', { corpo: { name, brand, category,
      variants: tamanhos.map((t) => ({ variant_name: t, price: 100, stock: 3 })) } });
    assert.ok(r.status < 300, String(r.bytes));
  }
});
after(() => s?.parar());

const buscar = async (q) => (await s.pedir('GET', `/api/products?detalhe=1&q=${encodeURIComponent(q)}`)).json;
const nomes = async (q) => [...new Set((await buscar(q)).itens.map((v) => v.product_name))];
const linhas = async (q) => (await buscar(q)).itens.map((v) => `${v.product_name} ${v.variant_name}`);

test('palavras em qualquer ordem, sem acento e sem maiúscula', async () => {
  assert.deepEqual((await nomes('lacoste bone')).sort(), ['Boné Lacoste Miami Open 2026', 'Boné Lacoste Sport 26']);
  assert.deepEqual(await nomes('BONÉ LACOSTE MIAMI'), ['Boné Lacoste Miami Open 2026']);
  assert.deepEqual(await nomes('miami lacoste'), ['Bermuda Beachwear Lacoste Miami Open', 'Boné Lacoste Miami Open 2026'].sort((a, b) => a.localeCompare(b, 'pt-BR')));
});

test('o tamanho escolhe a variação: "tênis nike 42" traz só o 42', async () => {
  assert.deepEqual((await linhas('tenis nike 42')).sort(), ['Tênis Nike Air Force 1 42', 'Tênis Nike Dunk Low 42']);
  assert.deepEqual(await linhas('camiseta nike g'), ['Camiseta Nike G']);
  assert.deepEqual(await linhas('polo tommy m'), ['Camisa Polo Tommy Hilfiger M']);
  // Número que é do nome do produto não vira tamanho: o Pro 13 vem inteiro.
  assert.deepEqual(await linhas('mizuno pro 13'), ['Tênis Mizuno Pro 13 41', 'Tênis Mizuno Pro 13 42']);
  assert.deepEqual(await nomes('530'), ['Tênis New Balance 530']);
  // "g" sozinho é tamanho: não acha a palavra que só começa com g.
  assert.ok((await linhas('g')).every((l) => / G$/.test(l)));
});

test('começo de palavra, plural e um erro de digitação', async () => {
  assert.deepEqual(await nomes('lac sport'), ['Boné Lacoste Sport 26']);
  assert.ok((await nomes('camisetas')).includes('Camiseta Nike'));
  assert.deepEqual((await nomes('lacsote bone')).sort(), ['Boné Lacoste Miami Open 2026', 'Boné Lacoste Sport 26']);
  assert.ok((await nomes('camieta nike')).includes('Camiseta Nike'));
  assert.deepEqual(await nomes('dunk lwo'), ['Tênis Nike Dunk Low']);
});

test('palavras parentes e apelidos da loja', async () => {
  const tenis = (await nomes('sneaker nike')).sort();
  assert.deepEqual(tenis, ['Tênis Nike Air Force 1', 'Tênis Nike Dunk Low']);
  assert.deepEqual(await nomes('hoodie nike'), ['Conjunto Moletom Nike']);
  assert.ok((await nomes('short lacoste')).includes('Bermuda Beachwear Lacoste Miami Open'));
  assert.deepEqual(await nomes('lv'), ['Camiseta Louis Vuitton']);
  assert.deepEqual(await nomes('af1'), ['Tênis Nike Air Force 1']);
  assert.deepEqual(await nomes('airforce'), ['Tênis Nike Air Force 1']);
  assert.deepEqual(await nomes('rayban'), ['Óculos Ray-Ban']);
  assert.ok((await nomes('chinelos')).includes('Chinelo Prada'));
});

test('o que mais combina vem primeiro', async () => {
  // "camisa" é exatamente a Camisa Polo; camiseta é parente, vem depois.
  const r = await nomes('camisa');
  assert.equal(r[0], 'Camisa Polo Tommy Hilfiger');
  assert.ok(r.includes('Camiseta Nike'));
});

test('palavra que não está no cadastro é deixada de lado, e a tela sabe qual', async () => {
  const r = await buscar('camiseta nike preta');
  assert.deepEqual(r.ignoradas, ['preta']);
  assert.deepEqual([...new Set(r.itens.map((v) => v.product_name))], ['Camiseta Nike']);
  // Cada palavra existe, mas nenhum produto tem as duas: mostra os parecidos.
  const p = await buscar('mizuno prada');
  assert.equal(p.parecidos, true);
  assert.ok(p.itens.length > 0);
});

test('a lista sem "detalhe" continua uma lista (o agente usa assim)', async () => {
  const r = await s.pedir('GET', '/api/products?q=lacoste');
  assert.ok(Array.isArray(r.json));
});

test('a aba Estoque usa a mesma busca', async () => {
  const r = (await s.pedir('GET', `/api/catalog?q=${encodeURIComponent('lacoste bone miami')}`)).json;
  assert.deepEqual(r.map((p) => p.name), ['Boné Lacoste Miami Open 2026']);
  const t = (await s.pedir('GET', `/api/catalog?q=${encodeURIComponent('TÊNIS')}`)).json.map((p) => p.name);
  assert.ok(t.includes('Tênis Nike Dunk Low') && t.includes('Tênis Mizuno Pro 13'));
});

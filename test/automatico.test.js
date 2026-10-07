// O motor automático tem que aguentar a internet real: conexão que cai
// no meio, loja que falha, lista que termina num múltiplo exato da página.
// Uma tarefa que falha não pode travar as outras, e o erro tem que ficar
// na tarefa certa (é o que a tela Conectar mostra).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { subirServidor } from './servidor.js';

const LOJA = '123';
const produto = (id, estoque) => ({
  id, name: { pt: `Produto ${id}` }, description: { pt: '' }, published: true, categories: [], images: [],
  variants: [{ id: id * 10 + 1, values: [{ pt: 'M' }], price: '100.00', sku: '', stock: estoque, stock_management: true }],
});

// Nuvemshop de mentira. "derrubar": quantas leituras de produtos caem
// (conexão fechada no meio). Página depois da última: 404, como a de verdade.
function lojaDeMentira({ produtos, pedidos = [], derrubar = 0, sumidas = 0 }) {
  // "sumidas": quantas leituras de variação respondem 404 (produto apagado
  // na loja entre uma releitura e outra).
  const estado = { derrubar, leiturasDeProdutos: 0, sumidas, escritas: 0 };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const [, recurso, pid, sub, vid] = url.pathname.split('/').filter(Boolean);
    const per = Number(url.searchParams.get('per_page')) || 50, page = Number(url.searchParams.get('page')) || 1;
    const json = (st, d) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    const paginado = (lista) => {
      const fatia = lista.slice((page - 1) * per, page * per);
      if (!fatia.length && page > 1) return json(404, { code: 404, description: `Last page is ${Math.ceil(lista.length / per)}` });
      return json(200, fatia);
    };
    if (recurso === 'products' && !pid) {
      estado.leiturasDeProdutos += 1;
      if (estado.derrubar > 0) { estado.derrubar -= 1; return req.socket.destroy(); }
      return paginado(produtos);
    }
    if (recurso === 'products' && sub === 'variants') {
      if (req.method === 'GET' && estado.sumidas > 0) { estado.sumidas -= 1; return json(404, { description: 'Product with such id does not exist' }); }
      if (req.method === 'PUT') estado.escritas += 1;
      const v = produtos.flatMap((p) => p.variants).find((x) => String(x.id) === vid);
      return json(200, v);
    }
    if (recurso === 'orders') return paginado(pedidos);
    return json(200, []);
  });
  return { srv, estado };
}

const servidores = [];
after(() => servidores.forEach((x) => { x.s?.parar(); x.srv.close(); }));
async function subir(opcoes) {
  const { srv, estado } = lojaDeMentira(opcoes);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const s = await subirServidor({ NUVEMSHOP_STORE_ID: LOJA, NUVEMSHOP_ACCESS_TOKEN: 'x',
    NUVEMSHOP_API_BASE: `http://127.0.0.1:${srv.address().port}`, PRIMEIRA_RODADA_MS: '200', NUVEMSHOP_ESPERAS_MS: '50,100' });
  servidores.push({ s, srv });
  // Espera a primeira volta do motor terminar (clientes é a penúltima tarefa).
  for (let i = 0; i < 80; i++) {
    const a = (await s.pedir('GET', '/api/connection')).json.automatico;
    if (a.clientes.ultima || a.clientes.erro) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return { s, estado, auto: async () => (await s.pedir('GET', '/api/connection')).json.automatico };
}

test('a conexão caiu uma vez: tenta de novo sozinho e dá certo', async () => {
  const { s, estado, auto } = await subir({ produtos: [produto(100, 4)], derrubar: 1 });
  const a = await auto();
  assert.ok(a.estoque.ultima);
  assert.equal(a.estoque.erro, null);
  assert.ok(estado.leiturasDeProdutos >= 2);
  assert.equal(s.banco().prepare('SELECT stock FROM variants WHERE nuvemshop_variant_id = ?').get('1001').stock, 4);
});

test('a loja falha sempre no estoque: o erro fica no estoque, e o resto roda', async () => {
  const { auto } = await subir({ produtos: [produto(100, 4)], derrubar: 99 });
  const a = await auto();
  assert.equal(a.estoque.ultima, null);
  assert.match(a.estoque.erro, /Falha de rede com a Nuvemshop/);
  assert.ok(a.pedidos.ultima);            // pedidos rodou
  assert.equal(a.pedidos.erro, null);     // e o erro não foi parar nele
  assert.ok(a.clientes.ultima);           // clientes rodou mesmo com o estoque falhando
});

test('total múltiplo exato da página: o 404 da página seguinte é o fim, não erro', async () => {
  const produtos = Array.from({ length: 50 }, (_, i) => produto(1000 + i, 1));
  const pedidos = Array.from({ length: 50 }, (_, i) => ({ id: 5000 + i, number: 5000 + i, created_at: new Date().toISOString(),
    status: 'open', payment_status: 'pending', total: '10.00', storefront: 'store', products: [] }));
  const { s, auto } = await subir({ produtos, pedidos });
  const a = await auto();
  assert.equal(a.estoque.erro, null);
  assert.equal(a.pedidos.erro, null);
  assert.equal(s.banco().prepare('SELECT COUNT(*) n FROM products WHERE nuvemshop_product_id IS NOT NULL').get().n, 50);
});

test('conferir a permissão: peça apagada na loja (404) não vira "sem permissão"', async () => {
  // A primeira peça escolhida sumiu da loja: tenta a próxima e fica verde.
  const { s, estado } = await subir({ produtos: [produto(100, 4), produto(200, 3), produto(300, 2)], sumidas: 1 });
  const con = (await s.pedir('GET', '/api/connection')).json;
  assert.equal(con.escrita.ok, true);
  assert.equal(estado.escritas, 1);
  // Todas somem: o resultado é "não deu para saber", nunca "sem permissão".
  estado.sumidas = 99;
  const r = (await s.pedir('POST', '/api/connection/testar-escrita')).json;
  assert.equal(r.ok, false);
  assert.equal(r.inconclusivo, true);
  assert.equal((await s.pedir('GET', '/api/connection')).json.escrita.ok, true);   // continua o que se sabia
});

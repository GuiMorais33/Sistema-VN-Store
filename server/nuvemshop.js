// ============================================================
//  Cliente da API da Nuvemshop.
//  Detalhes que, se errados, nada sincroniza:
//   - Header de auth é "Authentication: bearer <token>"
//     (não é o "Authorization" padrão).
//   - "User-Agent" identificando o app é OBRIGATÓRIO.
//  Docs: https://tiendanube.github.io/api-documentation/
// ============================================================

import { getSetting, setSetting } from './db.js';

// Credenciais lidas dinamicamente: primeiro do banco (tela Conectar),
// depois do .env como fallback. Assim conectar não exige reiniciar.
function cfg() {
  return {
    storeId: getSetting('nuvemshop_store_id') || process.env.NUVEMSHOP_STORE_ID || '',
    token: getSetting('nuvemshop_access_token') || process.env.NUVEMSHOP_ACCESS_TOKEN || '',
    clientId: getSetting('nuvemshop_client_id') || process.env.NUVEMSHOP_CLIENT_ID || '',
    clientSecret: getSetting('nuvemshop_client_secret') || process.env.NUVEMSHOP_CLIENT_SECRET || '',
    appName: process.env.NUVEMSHOP_APP_NAME || 'VN Store Sistema',
    email: process.env.NUVEMSHOP_CONTACT_EMAIL || 'contato@vnstore',
  };
}

export function isConfigured() {
  const c = cfg();
  return Boolean(c.storeId && c.token && c.storeId !== '000000');
}

export function connectionInfo() {
  const c = cfg();
  let escrita = null;
  try { escrita = JSON.parse(getSetting('nuvemshop_escrita') || 'null'); } catch (_) { /* valor antigo */ }
  return {
    connected: isConfigured(), store_id: c.storeId || null, has_app: Boolean(c.clientId && c.clientSecret),
    // O que o app pode fazer na loja (vem na autorização) e se gravar estoque
    // já funcionou de verdade — sem "produtos: escrita", o estoque não sobe.
    scope: getSetting('nuvemshop_scope') || null,
    escrita,
  };
}

// Anota se a loja aceitou (ou recusou por permissão) uma gravação.
export function anotarEscrita(ok, erro) {
  setSetting('nuvemshop_escrita', JSON.stringify({ ok, quando: new Date().toISOString(), erro: erro || null }));
}

// Troca o "code" (recebido no callback) pelo access_token da loja.
export async function exchangeCodeForToken(code) {
  const c = cfg();
  if (!c.clientId || !c.clientSecret) throw new Error('Configure o App ID e o Secret antes de conectar.');
  const res = await fetch('https://www.tiendanube.com/apps/authorize/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': `${c.appName} (${c.email})` },
    body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code }),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Falha ao obter o token (${res.status}): ${typeof data === 'string' ? data : (data.error_description || JSON.stringify(data))}`);
  return data; // { access_token, token_type, scope, user_id }
}

function headers() {
  const c = cfg();
  return {
    'Authentication': `bearer ${c.token}`,
    'User-Agent': `${c.appName} (${c.email})`,
    'Content-Type': 'application/json',
  };
}

// Leitura (GET) que falha por rede ou por loja ocupada (429/5xx) tenta de
// novo sozinha, com espera — a internet do servidor oscila e a Nuvemshop
// às vezes derruba conexão. Gravação (PUT/POST) não repete aqui: quem grava
// estoque tem a própria fila de novas tentativas (server/estoque.js).
const ESPERAS_MS = (process.env.NUVEMSHOP_ESPERAS_MS || '1500,5000').split(',').map(Number);
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function request(method, path, body) {
  if (!isConfigured()) {
    throw new Error('Nuvemshop não conectada. Abra a tela "Conectar loja".');
  }
  const apiBase = process.env.NUVEMSHOP_API_BASE || 'https://api.tiendanube.com/v1';
  const tentativas = method === 'GET' ? ESPERAS_MS.length + 1 : 1;
  for (let t = 1; ; t++) {
    try {
      return await chamar(apiBase, method, path, body);
    } catch (err) {
      const passageiro = !err.status || err.status === 429 || err.status >= 500;
      if (!passageiro || t >= tentativas) throw err;
      await espera(ESPERAS_MS[t - 1]);
    }
  }
}
async function chamar(apiBase, method, path, body) {
  let res;
  try {
    res = await fetch(`${apiBase}/${cfg().storeId}${path}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45000),   // pedido que trava não segura o motor
    });
  } catch (err) {
    // "fetch failed" sozinho não diz nada: o motivo de verdade vem em cause.
    const motivo = err.name === 'TimeoutError' ? 'a loja demorou mais de 45 s para responder'
      : (err.cause && (err.cause.code || err.cause.message)) || err.message;
    throw new Error(`Falha de rede com a Nuvemshop (${motivo})`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data && data.description ? data.description : (typeof data === 'string' ? data : res.statusText);
    const err = new Error(`Nuvemshop ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return { data, res };
}

// Uma página de uma lista. Pedir a página depois da última dá 404 ("Last
// page is…") quando o total é múltiplo exato do tamanho da página: isso é
// o fim da lista, não erro.
async function pagina(path, page) {
  try {
    const { data } = await request('GET', path);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.status === 404 && page > 1) return [];
    throw err;
  }
}

// Percorre os produtos página por página, entregando cada uma assim que
// chega — para ler o catálogo inteiro sem guardar tudo na memória (o
// servidor é pequeno). Página menor também falha menos.
export async function percorrerProdutos({ perPage = 50, maxPages = 400 } = {}, porPagina) {
  for (let page = 1; page <= maxPages; page++) {
    const data = await pagina(`/products?per_page=${perPage}&page=${page}`, page);
    if (data.length === 0) break;
    await porPagina(data);
    if (data.length < perPage) break;
  }
}

// Busca TODOS os produtos, paginando (per_page máx. 200).
// IMPORTANTE: não usar "fields" restritivo — precisamos de brand,
// categories, images e published, senão vêm vazios.
// opts.publishedOnly: traz só os produtos visíveis na loja.
export async function listAllProducts(opts = {}) {
  const all = [];
  let page = 1;
  const perPage = 200;
  const pub = opts.publishedOnly ? '&published=true' : '';
  const maxPages = opts.maxPages || 200; // trava de segurança
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await pagina(`/products?per_page=${perPage}&page=${page}${pub}`, page);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < perPage) break;
    page += 1;
    if (page > maxPages) break;
  }
  return all;
}

// Pedidos da loja (vendas do site). opts.since = AAAA-MM-DD.
export async function listOrders(opts = {}) {
  const all = [];
  let page = 1;
  const per = 50;
  const since = opts.since ? `&created_at_min=${opts.since}T00:00:00-03:00` : '';
  const status = opts.status ? `&status=${opts.status}` : '';
  const maxPages = opts.maxPages || 40;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await pagina(`/orders?per_page=${per}&page=${page}${since}${status}`, page);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < per) break;
    page += 1;
    if (page > maxPages) break;
  }
  return all;
}

// Carrinhos abandonados: quem chegou no checkout, deixou o contato e
// não terminou. A loja só gera o registro depois de ~6 horas.
// opts.since = AAAA-MM-DD.
export async function listAbandonedCheckouts(opts = {}) {
  const all = [];
  let page = 1;
  const per = 50;
  const since = opts.since ? `&created_at_min=${opts.since}T00:00:00-03:00` : '';
  const maxPages = opts.maxPages || 20;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await pagina(`/checkouts?per_page=${per}&page=${page}${since}`, page);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < per) break;
    page += 1;
    if (page > maxPages) break;
  }
  return all;
}

// Categorias da loja (id + nome), para espelhar a organização do site.
export async function listAllCategories() {
  const all = [];
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await pagina(`/categories?per_page=200&page=${page}`, page);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 200) break;
    page += 1;
    if (page > 20) break;
  }
  return all;
}

// Uma variante como ela está na loja agora (stock vem null quando a loja
// não controla o estoque dela).
export async function getVariant(productId, variantId) {
  const { data } = await request('GET', `/products/${productId}/variants/${variantId}`);
  return data;
}

// Define o estoque ABSOLUTO de uma variante. O valor tem que sair do que
// a loja tem agora (getVariant) — nunca do número guardado aqui, que não
// sabe das vendas do site. Quem calcula é o server/estoque.js.
export async function setVariantStock(productId, variantId, stock) {
  try {
    const { data } = await request(
      'PUT',
      `/products/${productId}/variants/${variantId}`,
      { stock: Math.max(0, Math.round(stock)) }
    );
    if (!escritaOk()) anotarEscrita(true);
    return data;
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      anotarEscrita(false, 'A Nuvemshop recusou: o app não tem permissão para mudar produtos (estoque).');
    }
    throw err;
  }
}
const escritaOk = () => { try { return JSON.parse(getSetting('nuvemshop_escrita') || 'null')?.ok === true; } catch (_) { return false; } };

// -------- Produtos (criar / atualizar na Nuvemshop) --------
export async function getProduct(nuvemshopProductId) {
  const { data } = await request('GET', `/products/${nuvemshopProductId}`);
  return data; // inclui variants[] com o estoque atual da loja
}
export async function createProduct(payload) {
  const { data } = await request('POST', '/products', payload);
  return data; // inclui id e variants[] criados
}
export async function updateProduct(nuvemshopProductId, payload) {
  const { data } = await request('PUT', `/products/${nuvemshopProductId}`, payload);
  return data;
}
export async function addProductImage(nuvemshopProductId, image) {
  // image: { src: 'https://...' } ou { attachment: '<base64>', filename: 'foto.jpg' }
  const { data } = await request('POST', `/products/${nuvemshopProductId}/images`, image);
  return data;
}
export async function deleteProductImage(nuvemshopProductId, imageId) {
  const { data } = await request('DELETE', `/products/${nuvemshopProductId}/images/${imageId}`);
  return data;
}
export async function listProductImages(nuvemshopProductId) {
  const { data } = await request('GET', `/products/${nuvemshopProductId}/images`);
  return Array.isArray(data) ? data : [];
}

// -------- Categorias (resolver por nome; criar se faltar) --------
export async function listCategories() {
  const { data } = await request('GET', '/categories?per_page=200&fields=id,name');
  return Array.isArray(data) ? data : [];
}
export async function createCategory(name, parentId) {
  const body = { name: { pt: name } };
  if (parentId) body.parent = parentId;   // ex.: criar a marca dentro de "MARCAS"
  const { data } = await request('POST', '/categories', body);
  return data;
}

// -------- Clientes --------
export async function createCustomer(payload) {
  const { data } = await request('POST', '/customers', payload);
  return data;
}

// Todos os clientes da loja (paginado).
export async function listAllCustomers(opts = {}) {
  const all = [];
  let page = 1;
  const per = 200;
  const maxPages = opts.maxPages || 100;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const data = await pagina(`/customers?per_page=${per}&page=${page}`, page);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < per) break;
    page += 1;
    if (page > maxPages) break;
  }
  return all;
}


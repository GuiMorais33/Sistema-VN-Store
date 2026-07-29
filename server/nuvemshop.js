// ============================================================
//  Cliente da API da Nuvemshop.
//  Detalhes que, se errados, nada sincroniza:
//   - Header de auth é "Authentication: bearer <token>"
//     (não é o "Authorization" padrão).
//   - "User-Agent" identificando o app é OBRIGATÓRIO.
//  Docs: https://tiendanube.github.io/api-documentation/
// ============================================================

import { getSetting } from './db.js';

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
  return { connected: isConfigured(), store_id: c.storeId || null, has_app: Boolean(c.clientId && c.clientSecret) };
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

async function request(method, path, body) {
  if (!isConfigured()) {
    throw new Error('Nuvemshop não conectada. Abra a tela "Conectar loja".');
  }
  const apiBase = process.env.NUVEMSHOP_API_BASE || 'https://api.tiendanube.com/v1';
  const res = await fetch(`${apiBase}/${cfg().storeId}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
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
    const { data } = await request('GET', `/products?per_page=${perPage}&page=${page}${pub}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < perPage) break;
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
    const { data } = await request('GET', `/categories?per_page=200&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 200) break;
    page += 1;
    if (page > 20) break;
  }
  return all;
}

// Define o estoque ABSOLUTO de uma variante (idempotente e seguro
// contra corridas — enviamos o valor final, não um decremento).
export async function setVariantStock(productId, variantId, stock) {
  const { data } = await request(
    'PUT',
    `/products/${productId}/variants/${variantId}`,
    { stock: Math.max(0, Math.round(stock)) }
  );
  return data;
}

// -------- Produtos (criar / atualizar na Nuvemshop) --------
export async function createProduct(payload) {
  const { data } = await request('POST', '/products', payload);
  return data; // inclui id e variants[] criados
}
export async function updateProduct(nuvemshopProductId, payload) {
  const { data } = await request('PUT', `/products/${nuvemshopProductId}`, payload);
  return data;
}
export async function addProductImage(nuvemshopProductId, image) {
  // image: { src: 'https://...' }  ou  { base64: '...', filename: 'foto.jpg' }
  const { data } = await request('POST', `/products/${nuvemshopProductId}/images`, image);
  return data;
}

// -------- Categorias (resolver por nome; criar se faltar) --------
export async function listCategories() {
  const { data } = await request('GET', '/categories?per_page=200&fields=id,name');
  return Array.isArray(data) ? data : [];
}
export async function createCategory(name) {
  const { data } = await request('POST', '/categories', { name: { pt: name } });
  return data;
}

// -------- Clientes --------
export async function createCustomer(payload) {
  const { data } = await request('POST', '/customers', payload);
  return data;
}


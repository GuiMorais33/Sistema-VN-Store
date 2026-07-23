// ============================================================
//  Cliente da API da Nuvemshop.
//  Detalhes que, se errados, nada sincroniza:
//   - Header de auth é "Authentication: bearer <token>"
//     (não é o "Authorization" padrão).
//   - "User-Agent" identificando o app é OBRIGATÓRIO.
//  Docs: https://tiendanube.github.io/api-documentation/
// ============================================================

const STORE_ID = process.env.NUVEMSHOP_STORE_ID;
const TOKEN = process.env.NUVEMSHOP_ACCESS_TOKEN;
const APP_NAME = process.env.NUVEMSHOP_APP_NAME || 'VN Store Sistema';
const EMAIL = process.env.NUVEMSHOP_CONTACT_EMAIL || 'contato@vnstore';
const BASE = `https://api.tiendanube.com/v1/${STORE_ID}`;

export function isConfigured() {
  return Boolean(STORE_ID && TOKEN && STORE_ID !== '000000');
}

function headers() {
  return {
    'Authentication': `bearer ${TOKEN}`,
    'User-Agent': `${APP_NAME} (${EMAIL})`,
    'Content-Type': 'application/json',
  };
}

async function request(method, path, body) {
  if (!isConfigured()) {
    throw new Error('Nuvemshop não configurada (defina NUVEMSHOP_STORE_ID e NUVEMSHOP_ACCESS_TOKEN no .env).');
  }
  const res = await fetch(`${BASE}${path}`, {
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
export async function listAllProducts() {
  const all = [];
  let page = 1;
  const perPage = 200;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await request('GET', `/products?per_page=${perPage}&page=${page}&fields=id,name,variants`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < perPage) break;
    page += 1;
    if (page > 50) break; // trava de segurança
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

export const nuvemshopConfig = { STORE_ID, APP_NAME, EMAIL, BASE };

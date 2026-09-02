// ============================================================
//  Servidor VN Store — API + painel + PDV + clientes + produtos.
//  Roda em "modo demonstração" sem token; fica ao vivo quando o
//  .env com as credenciais da Nuvemshop é preenchido.
// ============================================================
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db, { seedDemoIfEmpty, getSetting, setSetting, seedCategories, categoryId, migrateOldCategories } from './db.js';
import * as nuvem from './nuvemshop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const UPLOADS = join(PUBLIC, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
app.set('trust proxy', true); // atrás do Caddy (HTTPS): usa X-Forwarded-Proto/Host
app.use(express.json({ limit: '10mb' }));

// ---- Login por senha única (protege o sistema quando publicado) ----
// Se APP_PASSWORD estiver vazio (ex.: rodando local), não exige login.
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'troque-este-segredo-no-.env';
const AUTH_TOKEN = crypto.createHmac('sha256', SESSION_SECRET).update('vnstore-auth-v1').digest('hex');
function readCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('='); return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }).filter((a) => a[0]));
}
const authed = (req) => !APP_PASSWORD || readCookies(req).vn_auth === AUTH_TOKEN;

app.post('/api/login', (req, res) => {
  if (APP_PASSWORD && (req.body && req.body.password) === APP_PASSWORD) {
    res.setHeader('Set-Cookie', `vn_auth=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Senha incorreta.' });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'vn_auth=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
// Barreira: libera login, health e assets; bloqueia o resto sem sessão.
app.use((req, res, next) => {
  if (authed(req)) return next();
  const p = req.path;
  if (p === '/login' || p === '/api/login' || p === '/api/health' || p === '/oauth/callback' || /\.(css|js|webp|png|jpe?g|svg|ico|woff2?)$/i.test(p)) return next();
  if (p.startsWith('/api/')) return res.status(401).json({ error: 'não autenticado' });
  return res.redirect('/login');
});

app.use(express.static(PUBLIC));

const isLive = () => nuvem.isConfigured();
const now = () => new Date().toISOString();
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nameOf = (obj) => {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj.pt || obj.es || obj.en || Object.values(obj)[0] || '';
};

// ---- Estoque real x estoque do site ----
// Tênis (e afins) ficam no site com a grade toda de numeração, mas aqui
// existe só o par que temos em mãos. Todo cálculo de "quanto eu tenho" e
// "quanto vale" usa ESTE número, nunca a grade do site.
// Exige que a consulta tenha "v" (variants) e "p" (products) no FROM.
const REAL = `CASE WHEN p.on_demand = 1 THEN COALESCE(v.on_hand,0) ELSE v.stock END`;

if (seedCategories()) console.log('› Plano de contas padrão criado.');
{ const m = migrateOldCategories(); if (m) console.log(`› ${m} categoria(s) antiga(s) traduzida(s) para o plano de contas.`); }
if (!isLive() && seedDemoIfEmpty()) console.log('› Modo demonstração: catálogo e clientes de exemplo criados.');

// ---------------------- Saúde ----------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: isLive() ? 'live' : 'demo',
    store_id: nuvem.connectionInfo().store_id,
    products: db.prepare('SELECT COUNT(*) AS n FROM products').get().n,
    variants: db.prepare('SELECT COUNT(*) AS n FROM variants').get().n,
  });
});

// ==================== PRODUTOS (PDV) ====================
app.get('/api/products', (req, res) => {
  const q = (req.query.q || '').trim();
  // on_demand + on_hand: no PDV o tênis aparece na numeração toda, mas
  // marcado quando o par tem que ser buscado no fornecedor.
  const base = `SELECT v.*, p.brand, p.category, p.image_url, p.on_demand,
      ${REAL} AS real_stock
    FROM variants v LEFT JOIN products p ON p.id = v.product_id`;
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(`${base} WHERE v.product_name LIKE ? OR v.variant_name LIKE ? OR v.sku LIKE ? OR p.brand LIKE ? OR p.category LIKE ? ORDER BY v.product_name, v.variant_name LIMIT 120`).all(like, like, like, like, like);
  } else {
    rows = db.prepare(`${base} ORDER BY v.product_name, v.variant_name LIMIT 120`).all();
  }
  res.json(rows);
});

// ==================== CATÁLOGO (gestão) ====================
// Lista produtos-mestre com estoque, valor a custo e nº de variações.
app.get('/api/catalog', (req, res) => {
  const q = (req.query.q || '').trim();
  const cat = (req.query.category || '').trim();
  const brand = (req.query.brand || '').trim();
  const where = [];
  const args = [];
  if (q) { where.push('(p.name LIKE ? OR p.brand LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  // Categoria: o produto pode estar em várias (como no site) — busca em todas.
  if (cat) { where.push('(p.category = ? OR p.categories_all LIKE ?)'); args.push(cat, `%${cat}%`); }
  if (brand) { where.push('p.brand = ?'); args.push(brand); }
  // modo: proprio = só o que é meu | encomenda = só o que vem do fornecedor
  const modo = (req.query.modo || '').trim();
  if (modo === 'proprio') where.push('p.on_demand = 0');
  if (modo === 'encomenda') where.push('p.on_demand = 1');
  const rows = db.prepare(`
    SELECT p.*,
      COUNT(v.id) AS variant_count,
      COALESCE(SUM(${REAL}),0) AS total_stock,
      COALESCE(SUM(v.stock),0) AS site_stock,
      COALESCE(SUM(CASE WHEN p.on_demand = 1 THEN MAX(v.stock - COALESCE(v.on_hand,0), 0) ELSE 0 END),0) AS enc_stock,
      COALESCE(SUM(${REAL} * v.cost),0) AS stock_value_cost,
      COALESCE(MIN(v.price),0) AS min_price,
      COALESCE(MAX(v.price),0) AS max_price
    FROM products p LEFT JOIN variants v ON v.product_id = p.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    GROUP BY p.id ORDER BY p.name
  `).all(...args);
  res.json(rows);
});

// Resumo do estoque: valor total a custo, peças, e contagem por categoria/marca.
app.get('/api/catalog/summary', (req, res) => {
  const totals = db.prepare(`
    SELECT COALESCE(SUM(${REAL}),0) AS units,
           COALESCE(SUM(${REAL} * v.cost),0) AS value_cost,
           COALESCE(SUM(${REAL} * v.price),0) AS value_price,
           COALESCE(SUM(v.stock),0) AS site_units
    FROM variants v LEFT JOIN products p ON p.id = v.product_id
    WHERE v.stock_management = 1
  `).get();
  // O que está aqui (real) x o que está à venda sem estar aqui (encomenda).
  // Encomenda não tem dinheiro parado: o custo só existe quando vende.
  const real = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS products,
           COALESCE(SUM(${REAL}),0) AS units,
           COALESCE(SUM(${REAL} * v.cost),0) AS value_cost,
           COALESCE(SUM(${REAL} * v.price),0) AS value_price
    FROM products p JOIN variants v ON v.product_id = p.id
    WHERE v.stock_management = 1
  `).get();
  const encomenda = db.prepare(`
    SELECT COUNT(DISTINCT p.id) AS products,
           COALESCE(SUM(MAX(v.stock - COALESCE(v.on_hand,0), 0)),0) AS units,
           COALESCE(SUM(MAX(v.stock - COALESCE(v.on_hand,0), 0) * v.price),0) AS value_price,
           COALESCE(SUM(MAX(v.stock - COALESCE(v.on_hand,0), 0) * v.cost),0) AS value_cost
    FROM products p JOIN variants v ON v.product_id = p.id
    WHERE p.on_demand = 1 AND v.stock_management = 1
  `).get();
  // Encomendas ainda por buscar no fornecedor.
  encomenda.a_pegar = db.prepare(`SELECT COUNT(*) n FROM reminders WHERE kind='encomenda' AND done=0`).get().n;
  // Como foi a venda dos últimos 30 dias: peça que estava aqui x encomendada.
  const desde = new Date(Date.now() - 30 * 864e5).toISOString();
  const vendas = db.prepare(`SELECT
      COALESCE(SUM(i.qty - i.encomenda),0) AS pecas_real,
      COALESCE(SUM(i.encomenda),0) AS pecas_encomenda,
      COALESCE(SUM((i.qty - i.encomenda) * i.unit_price),0) AS valor_real,
      COALESCE(SUM(i.encomenda * i.unit_price),0) AS valor_encomenda
    FROM sale_items i JOIN sales s ON s.id = i.sale_id
    WHERE s.created_at >= ? AND s.payment_status <> 'cancelado'`).get(desde);
  const byCategory = db.prepare(`
    SELECT COALESCE(NULLIF(p.category,''),'(sem categoria)') AS label,
           COUNT(DISTINCT p.id) AS products,
           COALESCE(SUM(${REAL}),0) AS units,
           COALESCE(SUM(${REAL} * v.cost),0) AS value_cost
    FROM products p LEFT JOIN variants v ON v.product_id = p.id
    GROUP BY label ORDER BY units DESC
  `).all();
  const byBrand = db.prepare(`
    SELECT COALESCE(NULLIF(p.brand,''),'(sem marca)') AS label,
           COUNT(DISTINCT p.id) AS products,
           COALESCE(SUM(${REAL}),0) AS units,
           COALESCE(SUM(${REAL} * v.cost),0) AS value_cost
    FROM products p LEFT JOIN variants v ON v.product_id = p.id
    GROUP BY label ORDER BY units DESC
  `).all();
  res.json({ totals, real, encomenda, vendas_30d: vendas, by_category: byCategory, by_brand: byBrand });
});

app.get('/api/catalog/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado.' });
  p.variants = db.prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY id').all(p.id);
  res.json(p);
});

// Quantos pares/peças existem de verdade nesta variação.
// Produto normal: é o próprio estoque. Sob encomenda: só o que está aqui.
const emMaos = (v, sobEncomenda) => {
  if (!sobEncomenda) return parseInt(v.stock, 10) || 0;
  return Math.max(0, parseInt(v.on_hand, 10) || 0);
};

// Cria produto (mestre + variações) no nosso sistema e empurra p/ Nuvemshop.
app.post('/api/catalog', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Dê um nome ao produto.' });
  const variants = Array.isArray(b.variants) && b.variants.length ? b.variants : [{ variant_name: 'Único', sku: '', price: b.price || 0, cost: b.cost || 0, stock: b.stock || 0 }];
  const ts = now();
  const productId = db.transaction(() => {
    const sobEncomenda = b.on_demand ? 1 : 0;
    const pid = db.prepare(`INSERT INTO products (name, brand, category, description, image_url, weight, on_demand, published, synced_nuvemshop, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,0,?,?)`).run(String(b.name).trim(), b.brand || '', b.category || '', b.description || '',
        b.image_url || '', b.weight ? Number(b.weight) : null, sobEncomenda, b.published === false ? 0 : 1, ts, ts).lastInsertRowid;
    const insV = db.prepare(`INSERT INTO variants (product_id, product_name, variant_name, sku, price, cost, stock, on_hand, stock_management, updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?)`);
    for (const v of variants) {
      insV.run(pid, String(b.name).trim(), v.variant_name || 'Único', v.sku || '', money(v.price), money(v.cost),
        parseInt(v.stock, 10) || 0, emMaos(v, sobEncomenda), ts);
    }
    return pid;
  })();

  const sync = await pushProduct(productId);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  product.variants = db.prepare('SELECT * FROM variants WHERE product_id = ?').all(productId);
  res.json({ ok: true, product, sync });
});

// Atualiza produto e re-sincroniza.
app.put('/api/catalog/:id', async (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado.' });
  const b = req.body || {};
  const ts = now();
  db.transaction(() => {
    const sobEncomenda = b.on_demand !== undefined ? (b.on_demand ? 1 : 0) : p.on_demand;
    db.prepare(`UPDATE products SET name=?, brand=?, category=?, description=?, image_url=?, weight=?, on_demand=?, published=?, updated_at=? WHERE id=?`)
      .run(b.name ?? p.name, b.brand ?? p.brand, b.category ?? p.category, b.description ?? p.description,
        b.image_url ?? p.image_url, b.weight !== undefined ? (b.weight ? Number(b.weight) : null) : p.weight,
        sobEncomenda, b.published === false ? 0 : 1, ts, p.id);
    if (Array.isArray(b.variants)) {
      // A lista recebida é a lista COMPLETA de variações do produto.
      const upd = db.prepare('UPDATE variants SET variant_name=?, sku=?, price=?, cost=?, stock=?, on_hand=?, product_name=?, updated_at=? WHERE id=? AND product_id=?');
      const insV = db.prepare(`INSERT INTO variants (product_id, product_name, variant_name, sku, price, cost, stock, on_hand, stock_management, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?)`);
      const mantidos = new Set();
      for (const v of b.variants) {
        if (v.id) {
          upd.run(v.variant_name || 'Único', v.sku || '', money(v.price), money(v.cost), parseInt(v.stock, 10) || 0,
            emMaos(v, sobEncomenda), b.name ?? p.name, ts, v.id, p.id);
          mantidos.add(Number(v.id));
        } else {
          const novo = insV.run(p.id, b.name ?? p.name, v.variant_name || 'Único', v.sku || '', money(v.price), money(v.cost),
            parseInt(v.stock, 10) || 0, emMaos(v, sobEncomenda), ts);
          mantidos.add(Number(novo.lastInsertRowid));
        }
      }
      // Remove as que você tirou do formulário — preservando as que já
      // têm venda registrada (senão perderíamos o histórico).
      const atuais = db.prepare('SELECT id FROM variants WHERE product_id = ?').all(p.id);
      const temVenda = db.prepare('SELECT 1 FROM sale_items WHERE variant_id = ? LIMIT 1');
      const del = db.prepare('DELETE FROM variants WHERE id = ?');
      for (const { id } of atuais) {
        if (!mantidos.has(Number(id)) && !temVenda.get(id)) del.run(id);
      }
    }
  })();
  const sync = await pushProduct(p.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(p.id);
  product.variants = db.prepare('SELECT * FROM variants WHERE product_id = ?').all(p.id);
  res.json({ ok: true, product, sync });
});

// Duplicar: copia o produto como rascunho local para agilizar o
// lançamento de peças parecidas. NÃO leva a foto (é sempre outra) e
// NÃO publica sozinho — só sobe quando você salvar.
app.post('/api/catalog/:id/duplicate', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado.' });
  const variants = db.prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY id').all(p.id);
  const ts = now();
  const novoId = db.transaction(() => {
    // Leva o "sob encomenda": tênis novo costuma seguir a mesma regra.
    const id = db.prepare(`INSERT INTO products (name, brand, category, categories_all, description,
        image_url, weight, on_demand, published, synced_nuvemshop, created_at, updated_at)
      VALUES (?,?,?,?,?, '', ?, ?, 1, 0, ?, ?)`)
      .run(`${p.name} (cópia)`, p.brand, p.category, p.categories_all, p.description, p.weight, p.on_demand, ts, ts).lastInsertRowid;
    const ins = db.prepare(`INSERT INTO variants (product_id, product_name, variant_name, sku, price, cost, stock, on_hand, stock_management, updated_at)
      VALUES (?,?,?,'',?,?,0,0,1,?)`);   // sem SKU e com estoque zerado: você preenche o que chegou
    const base = variants.length ? variants : [{ variant_name: 'Único', price: 0, cost: 0 }];
    for (const v of base) ins.run(id, `${p.name} (cópia)`, v.variant_name || 'Único', v.price, v.cost, ts);
    return id;
  })();
  const novo = db.prepare('SELECT * FROM products WHERE id = ?').get(novoId);
  novo.variants = db.prepare('SELECT * FROM variants WHERE product_id = ?').all(novoId);
  res.json({ ok: true, product: novo });
});

app.post('/api/catalog/:id/push', async (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado.' });
  res.json({ ok: true, sync: await pushProduct(p.id) });
});

// Cria/atualiza o produto na Nuvemshop, no formato deles. Live-only.
async function pushProduct(productId) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  const variants = db.prepare('SELECT * FROM variants WHERE product_id = ?').all(productId);
  if (!isLive()) {
    db.prepare('UPDATE products SET synced_nuvemshop=0, sync_note=? WHERE id=?').run('Modo demonstração — não enviado à Nuvemshop.', productId);
    return { mode: 'demo', ok: false, note: 'Modo demonstração — conecte a Nuvemshop para publicar.' };
  }
  try {
    const hasSizes = variants.some((v) => v.variant_name && v.variant_name !== 'Único');
    const payload = {
      name: { pt: p.name },
      description: { pt: p.description || '' },
      published: p.published === 0 ? false : true, // sem isso o produto pode não aparecer no site
    };
    // Monta cada variante no formato da Nuvemshop.
    //  - price é o ÚNICO campo obrigatório da variante;
    //  - stock_management:true garante controle de estoque (pra sincronizar);
    //  - weight alimenta o cálculo de frete no checkout;
    //  - sku é OPCIONAL: só enviamos se estiver preenchido (você não usa SKU).
    const mkVariant = (v, withValues) => {
      const o = { price: String(v.price), stock: parseInt(v.stock, 10) || 0, stock_management: true };
      if (p.weight > 0) o.weight = String(p.weight);
      if (v.sku && String(v.sku).trim()) o.sku = String(v.sku).trim();
      if (withValues) o.values = [{ pt: v.variant_name }];
      return o;
    };
    if (hasSizes) {
      payload.attributes = [{ pt: 'Tamanho' }]; // 1 eixo de variação (ex.: P/M/G)
      payload.variants = variants.map((v) => mkVariant(v, true));
    } else {
      payload.variants = variants.map((v) => mkVariant(v, false));
    }
    // Categorias na loja. A loja organiza assim:
    //   MARCAS > Lacoste        (a marca)
    //   Camisetas               (a categoria do produto)
    // Então enviamos as duas, senão o produto não aparece no menu de
    // marcas do site.
    if (p.category || p.brand) {
      try {
        const cats = await nuvem.listAllCategories();
        const acha = (nome, paiId) => cats.find((c) => nameOf(c.name).trim().toLowerCase() === String(nome).trim().toLowerCase()
          && (paiId === undefined || c.parent === paiId));
        const ids = [];

        if (p.category) {
          let c = acha(p.category);
          if (!c) c = await nuvem.createCategory(p.category);
          if (c && c.id) ids.push(c.id);
        }
        if (p.brand) {
          const raizMarcas = cats.find((c) => /^marcas?$/i.test(nameOf(c.name).trim()));
          // procura a marca dentro de MARCAS; se não houver, em qualquer lugar
          let m = raizMarcas ? acha(p.brand, raizMarcas.id) : null;
          if (!m) m = acha(p.brand);
          if (!m) m = await nuvem.createCategory(p.brand, raizMarcas ? raizMarcas.id : undefined);
          if (m && m.id) {
            ids.push(m.id);
            if (raizMarcas && !ids.includes(raizMarcas.id)) ids.push(raizMarcas.id); // o produto fica sob "MARCAS" também
          }
        }
        if (ids.length) payload.categories = [...new Set(ids)];
      } catch (e) { /* segue sem categoria se falhar */ }
    }

    let result;
    if (p.nuvemshop_product_id) result = await nuvem.updateProduct(p.nuvemshop_product_id, payload);
    else result = await nuvem.createProduct(payload);

    // Grava os IDs da Nuvemshop de volta (produto e variações, por ordem).
    const ts = now();
    db.prepare('UPDATE products SET nuvemshop_product_id=?, synced_nuvemshop=1, sync_note=NULL, updated_at=? WHERE id=?').run(String(result.id), ts, productId);
    if (Array.isArray(result.variants)) {
      const updIds = db.prepare('UPDATE variants SET nuvemshop_product_id=?, nuvemshop_variant_id=? WHERE id=?');
      variants.forEach((v, i) => { const rv = result.variants[i]; if (rv) updIds.run(String(result.id), String(rv.id), v.id); });
    }
    // Foto: só sobe quando MUDOU. Antes, cada edição adicionava outra
    // cópia da mesma foto no produto da loja.
    if (p.image_url && p.image_url !== p.image_sent) {
      try {
        // Tira a foto anterior que este sistema tinha enviado.
        if (p.ns_image_id) {
          try { await nuvem.deleteProductImage(result.id, p.ns_image_id); } catch (e) { /* já pode não existir */ }
        }
        const nova = p.image_url.startsWith('/uploads/')
          ? await nuvem.addProductImage(result.id, {
              attachment: fs.readFileSync(join(PUBLIC, p.image_url)).toString('base64'),
              filename: p.image_url.split('/').pop(),
            })
          : await nuvem.addProductImage(result.id, { src: p.image_url });
        db.prepare('UPDATE products SET image_sent = ?, ns_image_id = ? WHERE id = ?')
          .run(p.image_url, nova && nova.id ? String(nova.id) : null, productId);
      } catch (e) { /* foto é best-effort: o produto já foi publicado */ }
    }

    return { mode: 'live', ok: true, nuvemshop_product_id: String(result.id) };
  } catch (err) {
    db.prepare('UPDATE products SET synced_nuvemshop=0, sync_note=? WHERE id=?').run(err.message, productId);
    return { mode: 'live', ok: false, note: err.message };
  }
}

// ==================== SINCRONIZAR (puxar da Nuvemshop) ====================
app.post('/api/sync', async (req, res) => {
  if (!isLive()) { const seeded = seedDemoIfEmpty(); return res.json({ mode: 'demo', seeded, message: 'Modo demonstração — sem loja conectada.' }); }
  const b = req.body || {};
  const onlyAvailable = b.only_available !== false;   // padrão: só o que tem unidade
  const publishedOnly = b.published_only !== false;   // padrão: só o que está no ar
  try {
    // A loja organiza a MARCA como subcategoria de "MARCAS" (o campo
    // brand da API não é usado). Montamos o índice a partir das
    // categorias reais para espelhar exatamente o site.
    const allCats = await nuvem.listAllCategories();
    const catById = new Map(allCats.map((c) => [c.id, c]));
    const rootMarcas = allCats.filter((c) => /^marcas?$/i.test(nameOf(c.name).trim()));
    const rootMarcasIds = new Set(rootMarcas.map((c) => c.id));
    const brandIds = new Set(allCats.filter((c) => rootMarcasIds.has(c.parent)).map((c) => c.id));
    const isBrandCat = (id) => brandIds.has(id);
    const isMarcasRoot = (id) => rootMarcasIds.has(id);

    const raw = await nuvem.listAllProducts({ publishedOnly });

    // Estoque total do produto (variação sem controle de estoque conta como disponível).
    const unitsOf = (p) => (p.variants || []).reduce((s, v) => {
      if (v.stock_management === false) return s + 1;
      return s + (parseInt(v.stock, 10) || 0);
    }, 0);

    const products = onlyAvailable ? raw.filter((p) => unitsOf(p) > 0) : raw;
    const skipped = raw.length - products.length;

    const upP = db.prepare(`INSERT INTO products (nuvemshop_product_id, name, brand, category, categories_all, description, image_url, published, synced_nuvemshop, created_at, updated_at)
      VALUES (@pid,@name,@brand,@category,@cats,@description,@image,@published,1,@now,@now)
      ON CONFLICT(nuvemshop_product_id) DO UPDATE SET
        name=excluded.name, brand=excluded.brand, category=excluded.category,
        categories_all=excluded.categories_all, description=excluded.description,
        image_url=excluded.image_url, published=excluded.published,
        synced_nuvemshop=1, updated_at=excluded.updated_at`);
    const getP = db.prepare('SELECT id FROM products WHERE nuvemshop_product_id = ?');
    // O custo é NOSSO: nunca sobrescrever no sync.
    const upV = db.prepare(`INSERT INTO variants (product_id, nuvemshop_product_id, nuvemshop_variant_id, product_name, variant_name, sku, price, cost, stock, stock_management, updated_at)
      VALUES (@product_id,@pid,@vid,@pname,@vname,@sku,@price,0,@stock,@sm,@now)
      ON CONFLICT(nuvemshop_variant_id) DO UPDATE SET
        product_id=excluded.product_id, product_name=excluded.product_name,
        variant_name=excluded.variant_name, sku=excluded.sku, price=excluded.price,
        stock=excluded.stock, stock_management=excluded.stock_management, updated_at=excluded.updated_at`);

    let variantCount = 0;
    const brands = new Set(), cats = new Set();

    db.transaction(() => {
      for (const p of products) {
        const name = nameOf(p.name);
        const image = (p.images && p.images[0] && p.images[0].src) || '';
        const prodCats = (p.categories || []);

        // MARCA = a categoria do produto que é filha de "MARCAS".
        // (Ex.: "Jaqueta Zara" → MARCAS > Zara → marca "Zara".)
        const brandCat = prodCats.find((c) => isBrandCat(c.id));
        const brand = brandCat ? nameOf(brandCat.name).trim() : (typeof p.brand === 'string' ? p.brand.trim() : '');

        // CATEGORIAS = as demais (tirando "MARCAS" e as marcas).
        const realCats = prodCats.filter((c) => !isBrandCat(c.id) && !isMarcasRoot(c.id));
        const catNames = realCats.map((c) => nameOf(c.name).trim()).filter(Boolean);
        // A principal é a mais específica (subcategoria vence a raiz):
        // ex.: "Coleção Inverno > Jaquetas" → "Jaquetas".
        const specific = realCats.find((c) => c.parent && catById.has(c.parent));
        const category = (specific ? nameOf(specific.name).trim() : catNames[0]) || '';

        if (brand) brands.add(brand);
        catNames.forEach((c) => cats.add(c));

        upP.run({
          pid: String(p.id), name, brand, category,
          cats: catNames.join(' | '),
          description: nameOf(p.description), image,
          published: p.published === false ? 0 : 1, now: now(),
        });
        const productId = getP.get(String(p.id)).id;

        for (const v of (p.variants || [])) {
          // Nome da variação: junta os valores dos atributos (ex.: "P / Verde").
          const vname = (v.values || []).map((x) => nameOf(x)).filter(Boolean).join(' / ') || 'Único';
          upV.run({
            product_id: productId, pid: String(p.id), vid: String(v.id), pname: name, vname,
            sku: v.sku || '', price: parseFloat(v.price) || 0,
            stock: v.stock == null ? 0 : parseInt(v.stock, 10),
            sm: v.stock_management === false ? 0 : 1, now: now(),
          });
          variantCount += 1;
        }
      }
      // O estoque veio da loja; em produto de estoque próprio "em mãos" é
      // o mesmo número. (Sob encomenda é nosso, e não se toca nele.)
      db.exec(`UPDATE variants SET on_hand = stock WHERE product_id IN
        (SELECT id FROM products WHERE on_demand = 0)`);
    })();

    res.json({
      mode: 'live', products: products.length, variants: variantCount,
      skipped_no_stock: skipped, scanned: raw.length,
      brands: brands.size, categories: cats.size,
      only_available: onlyAvailable, published_only: publishedOnly,
    });
  } catch (err) {
    console.error('Sync falhou:', err.message);
    res.status(502).json({ error: err.message });
  }
});




// Limpa os dados LOCAIS (catálogo, vendas, clientes, financeiro).
// Não toca em nada na Nuvemshop — serve para começar do zero, limpo.
app.post('/api/reset', (req, res) => {
  const keepConnection = db.prepare('SELECT key, value FROM settings').all();
  db.transaction(() => {
    db.exec(`DELETE FROM sale_items; DELETE FROM sales; DELETE FROM stock_movements;
             DELETE FROM financial_entries; DELETE FROM customers;
             DELETE FROM variants; DELETE FROM products;`);
  })();
  // (settings preservado: a conexão com a loja continua ativa)
  res.json({ ok: true, kept_settings: keepConnection.length });
});

// ==================== CUSTOS EM MASSA ====================
// Sem custo, margem e valor de estoque são mentira. Abrir 2.700 produtos
// um por um não acontece — então aqui a lista vem pronta para digitar.
app.get('/api/custos', (req, res) => {
  const q = (req.query.q || '').trim();
  const brand = (req.query.brand || '').trim();
  const cat = (req.query.category || '').trim();
  const soFalta = req.query.falta === '1';
  const where = [], args = [];
  if (q) { where.push('(v.product_name LIKE ? OR v.variant_name LIKE ? OR v.sku LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (brand) { where.push('p.brand = ?'); args.push(brand); }
  if (cat) { where.push('(p.category = ? OR p.categories_all LIKE ?)'); args.push(cat, `%${cat}%`); }
  if (soFalta) where.push('COALESCE(v.cost,0) <= 0');

  const rows = db.prepare(`
    SELECT v.id, v.product_id, v.product_name, v.variant_name, v.sku, v.price, v.cost,
           v.stock, COALESCE(v.on_hand,0) AS on_hand, p.brand, p.category, p.image_url,
           COALESCE(p.on_demand,0) AS on_demand
    FROM variants v LEFT JOIN products p ON p.id = v.product_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY (COALESCE(v.cost,0) <= 0) DESC, v.product_name, v.variant_name
    LIMIT 500
  `).all(...args);

  const resumo = db.prepare(`
    SELECT COUNT(*) total,
      SUM(CASE WHEN COALESCE(v.cost,0) <= 0 THEN 1 ELSE 0 END) sem_custo
    FROM variants v`).get();
  res.json({ resumo, variantes: rows });
});

// Grava vários custos de uma vez.
app.post('/api/custos', (req, res) => {
  const itens = Array.isArray((req.body || {}).itens) ? req.body.itens : [];
  if (!itens.length) return res.status(400).json({ error: 'Nada para salvar.' });
  const upd = db.prepare('UPDATE variants SET cost = ?, updated_at = ? WHERE id = ?');
  const ts = now();
  let n = 0, ignorados = 0;
  db.transaction(() => {
    for (const it of itens) {
      // Valida ANTES de arredondar: money() transforma texto em 0, e
      // gravar 0 por causa de um valor inválido apagaria o custo certo.
      const bruto = typeof it.cost === 'string' ? it.cost.replace(',', '.') : it.cost;
      const num = Number(bruto);
      if (bruto === '' || bruto == null || !Number.isFinite(num) || num < 0) { ignorados += 1; continue; }
      const r = upd.run(money(num), ts, it.variant_id);
      if (r.changes) n += r.changes; else ignorados += 1;
    }
  })();
  const resumo = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN COALESCE(cost,0) <= 0 THEN 1 ELSE 0 END) sem_custo FROM variants`).get();
  res.json({ ok: true, salvos: n, ignorados, resumo });
});

// ==================== FORNECEDORES ====================
app.get('/api/suppliers', (req, res) => {
  res.json(db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id) compras,
      (SELECT COALESCE(SUM(p.total),0) FROM purchases p WHERE p.supplier_id = s.id) gasto
    FROM suppliers s WHERE archived = 0 ORDER BY name`).all());
});

app.post('/api/suppliers', (req, res) => {
  const nome = String((req.body || {}).name || '').trim();
  if (!nome) return res.status(400).json({ error: 'Informe o nome do fornecedor.' });
  const existe = db.prepare('SELECT * FROM suppliers WHERE lower(name) = lower(?)').get(nome);
  if (existe) {
    if (existe.archived) db.prepare('UPDATE suppliers SET archived = 0 WHERE id = ?').run(existe.id);
    return res.json({ ok: true, supplier: db.prepare('SELECT * FROM suppliers WHERE id = ?').get(existe.id), ja_existia: true });
  }
  const b = req.body || {};
  const id = db.prepare('INSERT INTO suppliers (name, phone, note, created_at) VALUES (?,?,?,?)')
    .run(nome, b.phone || '', b.note || '', now()).lastInsertRowid;
  res.json({ ok: true, supplier: db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) });
});

// ==================== ENTRADA DE MERCADORIA ====================
// Uma entrada resolve três coisas de uma vez: soma o estoque (aqui e na
// loja), atualiza o custo da peça e lança a despesa no caixa.
app.post('/api/purchases', async (req, res) => {
  const b = req.body || {};
  const itens = Array.isArray(b.items) ? b.items : [];
  if (!itens.length) return res.status(400).json({ error: 'Adicione ao menos um item à entrada.' });

  // Fornecedor: usa o existente ou cria na hora.
  let fornId = b.supplier_id || null, fornNome = '';
  if (!fornId && b.supplier_name && String(b.supplier_name).trim()) {
    const nome = String(b.supplier_name).trim();
    const ex = db.prepare('SELECT id FROM suppliers WHERE lower(name) = lower(?)').get(nome);
    fornId = ex ? ex.id : db.prepare('INSERT INTO suppliers (name, created_at) VALUES (?,?)').run(nome, now()).lastInsertRowid;
  }
  if (fornId) {
    const s = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(fornId);
    fornNome = s ? s.name : '';
  }

  const getV = db.prepare(`SELECT v.*, COALESCE(p.on_demand,0) AS on_demand
    FROM variants v LEFT JOIN products p ON p.id = v.product_id WHERE v.id = ?`);
  const linhas = [];
  for (const it of itens) {
    const v = getV.get(it.variant_id);
    if (!v) return res.status(400).json({ error: `Produto não encontrado (id ${it.variant_id}).` });
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const custo = money(it.unit_cost != null ? it.unit_cost : v.cost);
    if (!(custo > 0)) return res.status(400).json({ error: `Informe o custo de "${v.product_name} ${v.variant_name}".` });
    linhas.push({ v, qty, custo, total: money(custo * qty) });
  }

  const frete = money(Math.max(0, parseFloat(b.freight) || 0));
  const totalItens = money(linhas.reduce((s, l) => s + l.total, 0));
  const total = money(totalItens + frete);
  const pago = b.paid === false ? 0 : 1;
  const ts = now();
  const code = 'EM-' + String(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM purchases').get().n).padStart(5, '0');

  const compraId = db.transaction(() => {
    const id = db.prepare(`INSERT INTO purchases (code, supplier_id, supplier_name, note, items_count, total, freight, paid, due_date, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(code, fornId, fornNome, b.note || '', linhas.reduce((s, l) => s + l.qty, 0), total, frete, pago, b.due_date || null, ts).lastInsertRowid;

    const insItem = db.prepare(`INSERT INTO purchase_items (purchase_id, variant_id, name, qty, unit_cost, line_total)
      VALUES (?,?,?,?,?,?)`);
    // Entrada soma o que existe de verdade (em mãos). O número do site
    // só sobe em produto de estoque próprio — sob encomenda a grade é sua.
    // Em estoque próprio "em mãos" é o próprio estoque — mantém os dois
    // iguais, senão o número deriva e mente se o produto virar encomenda.
    const updProprio = db.prepare(`UPDATE variants SET stock = stock + ?, on_hand = stock + ?,
      cost = ?, updated_at = ? WHERE id = ?`);
    const updEncomenda = db.prepare(`UPDATE variants SET on_hand = COALESCE(on_hand,0) + ?,
      cost = ?, updated_at = ? WHERE id = ?`);
    const insMove = db.prepare('INSERT INTO stock_movements (variant_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)');

    for (const l of linhas) {
      insItem.run(id, l.v.id, `${l.v.product_name} ${l.v.variant_name}`, l.qty, l.custo, l.total);
      if (l.v.on_demand) updEncomenda.run(l.qty, l.custo, ts, l.v.id);
      else updProprio.run(l.qty, l.qty, l.custo, ts, l.v.id);
      insMove.run(l.v.id, l.qty, 'entrada', code, ts);
    }

    // Caixa: a compra é despesa. Se ainda não pagou, fica agendada.
    db.prepare(`INSERT INTO financial_entries (type, category, category_id, description, amount, ref, paid, due_date, paid_at, created_at)
      VALUES ('despesa','Compra de mercadoria',?,?,?,?,?,?,?,?)`)
      .run(categoryId('Compra de mercadoria', 'despesa'),
        `Entrada ${code}${fornNome ? ' · ' + fornNome : ''}`, total, code,
        pago, pago ? null : (b.due_date || null), pago ? ts : null, ts);
    db.prepare('UPDATE purchases SET fin_posted = 1 WHERE id = ?').run(id);
    return id;
  })();

  // Sobe o novo estoque para a loja (só produto de estoque próprio).
  let sincOk = true; const notas = [];
  if (isLive()) {
    for (const l of linhas) {
      if (l.v.on_demand || !l.v.stock_management) continue;
      if (!l.v.nuvemshop_product_id || !l.v.nuvemshop_variant_id) continue;
      try { await nuvem.setVariantStock(l.v.nuvemshop_product_id, l.v.nuvemshop_variant_id, l.v.stock + l.qty); }
      catch (err) { sincOk = false; notas.push(`${l.v.product_name} ${l.v.variant_name}: ${err.message}`); }
    }
  } else { sincOk = false; notas.push('Modo demonstração — estoque não enviado à Nuvemshop.'); }
  db.prepare('UPDATE purchases SET synced_nuvemshop = ?, sync_note = ? WHERE id = ?')
    .run(sincOk && isLive() ? 1 : 0, notas.join(' | ') || null, compraId);

  res.json({
    ok: true, code, total, itens: linhas.length,
    pecas: linhas.reduce((s, l) => s + l.qty, 0),
    fornecedor: fornNome, paid: !!pago,
    stock_synced: sincOk && isLive(), notes: notas,
  });
});

// Histórico de entradas
app.get('/api/purchases', (req, res) => {
  const dias = parseInt(req.query.days, 10) || 90;
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  const rows = db.prepare(`SELECT * FROM purchases WHERE created_at >= ? ORDER BY id DESC LIMIT 100`).all(desde);
  const tot = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) total,
      COALESCE(SUM(CASE WHEN paid = 0 THEN total ELSE 0 END),0) a_pagar
    FROM purchases WHERE created_at >= ?`).get(desde);
  res.json({ resumo: tot, compras: rows });
});

app.get('/api/purchases/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Entrada não encontrada.' });
  c.items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(c.id);
  res.json(c);
});

// ==================== CLIENTES ====================
// Ranking: quanto cada cliente já gastou + pendências.
app.get('/api/customers', (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  const SEM_NOME = SQL_PESSOA;

  // "Gastou" = tudo que a pessoa levou, pago ou fiado — as peças já
  // saíram daqui, então o fiado também conta para a posição no ranking.
  // Só o que foi cancelado fica de fora. O que ainda não foi pago segue
  // visível à parte, em "a receber".
  const rows = db.prepare(`
    SELECT c.*,
      COUNT(CASE WHEN s.payment_status <> 'cancelado' THEN s.id END) AS orders,
      COALESCE(SUM(CASE WHEN s.payment_status IN ('pago','pendente') THEN s.total ELSE 0 END),0) AS total_spent,
      COALESCE(SUM(CASE WHEN s.payment_status='pago' THEN s.total ELSE 0 END),0) AS paid,
      COALESCE(SUM(CASE WHEN s.payment_status='pendente' THEN s.total ELSE 0 END),0) AS pending,
      MAX(CASE WHEN s.payment_status <> 'cancelado' THEN s.created_at END) AS last_purchase,
      CASE WHEN c.nuvemshop_customer_id IS NOT NULL THEN 1 ELSE 0 END AS da_loja
    FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
    WHERE ${SEM_NOME} ${q ? 'AND (c.name LIKE ? OR c.instagram LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)' : ''}
    GROUP BY c.id ORDER BY total_spent DESC, c.name
  `).all(...(q ? [like, like, like, like] : []));
  res.json(rows);
});

app.get('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });
  c.sales = db.prepare('SELECT id, code, total, payment_method, payment_status, created_at FROM sales WHERE customer_id = ? ORDER BY id DESC').all(c.id);
  const agg = db.prepare(`SELECT
    COUNT(CASE WHEN payment_status <> 'cancelado' THEN 1 END) AS orders,
    COALESCE(SUM(CASE WHEN payment_status IN ('pago','pendente') THEN total ELSE 0 END),0) AS total_spent,
    COALESCE(SUM(CASE WHEN payment_status='pago' THEN total ELSE 0 END),0) AS paid,
    COALESCE(SUM(CASE WHEN payment_status='pendente' THEN total ELSE 0 END),0) AS pending
    FROM sales WHERE customer_id = ?`).get(c.id);
  res.json({ ...c, ...agg });
});

// Normaliza o @: aceita "@fulano", "fulano" ou a URL do perfil.
const limpaInsta = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = /instagram\.com\/([A-Za-z0-9._]+)/i.exec(s);
  const handle = (m ? m[1] : s).replace(/^@+/, '').trim();
  return handle ? '@' + handle.replace(/\/+$/, '') : '';
};

app.post('/api/customers', async (req, res) => {
  const b = req.body || {};
  const nome = String(b.name || '').trim();
  if (!nome) return res.status(400).json({ error: 'Informe o nome do cliente.' });
  // Se digitaram só o @ no nome, ele também vira o Instagram.
  const insta = limpaInsta(b.instagram || (nome.startsWith('@') ? nome : ''));
  const id = db.prepare('INSERT INTO customers (name, instagram, phone, email, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(nome, insta, b.phone || '', b.email || '', b.note || '', now()).lastInsertRowid;
  res.json({ ok: true, customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(id) });
});

// Editar cliente
app.put('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const b = req.body || {};
  const nome = b.name !== undefined ? String(b.name).trim() : c.name;
  if (!nome) return res.status(400).json({ error: 'O nome não pode ficar vazio.' });
  db.prepare('UPDATE customers SET name=?, instagram=?, phone=?, email=?, note=? WHERE id=?')
    .run(nome,
      b.instagram !== undefined ? limpaInsta(b.instagram) : (c.instagram || ''),
      b.phone !== undefined ? String(b.phone).trim() : c.phone,
      b.email !== undefined ? String(b.email).trim() : c.email,
      b.note !== undefined ? String(b.note).trim() : c.note,
      c.id);
  // O nome também aparece nas vendas antigas — mantém coerente.
  db.prepare('UPDATE sales SET customer_name = ? WHERE customer_id = ?').run(nome, c.id);
  res.json({ ok: true, customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id) });
});

// Preenche o Instagram a partir dos nomes que já são um @.
function detectarInstagram() {
  const alvo = db.prepare("SELECT id, name FROM customers WHERE COALESCE(instagram,'') = '' AND name LIKE '@%'").all();
  const upd = db.prepare('UPDATE customers SET instagram = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => { for (const c of alvo) { const i = limpaInsta(c.name); if (i) { upd.run(i, c.id); n += 1; } } })();
  return n;
}

// ==================== VENDA (PDV) ====================
app.post('/api/sales', async (req, res) => {
  const { items = [], customer_id = null, new_customer = null, customer_name = '', payment_method = '', payment_status = 'pago', discount = 0, seller_id = null, atendimento_id = null } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Adicione ao menos um item à venda.' });

  // Cliente: usa existente, cria novo, ou anônimo.
  let custId = customer_id || null;
  let custName = customer_name || '';
  if (!custId && new_customer && new_customer.name) {
    const nn = new_customer.name.trim();
    const ni = limpaInsta(new_customer.instagram || (nn.startsWith('@') ? nn : ''));
    custId = db.prepare('INSERT INTO customers (name, instagram, phone, created_at) VALUES (?,?,?,?)')
      .run(nn, ni, new_customer.phone || '', now()).lastInsertRowid;
    custName = nn;
  } else if (custId) {
    const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(custId);
    if (c) custName = c.name;
  }

  const getVariant = db.prepare(`SELECT v.*, COALESCE(p.on_demand,0) AS on_demand
    FROM variants v LEFT JOIN products p ON p.id = v.product_id WHERE v.id = ?`);
  const lines = [];
  for (const it of items) {
    const v = getVariant.get(it.variant_id);
    if (!v) return res.status(400).json({ error: `Produto não encontrado (id ${it.variant_id}).` });
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    // Sob encomenda a grade do site não é estoque: é a lista de numerações
    // que você consegue entregar. Vender uma que não está aqui é o normal
    // (o par vem do fornecedor no mesmo dia), então nunca trava a venda.
    if (!v.on_demand && v.stock_management && v.stock < qty) {
      return res.status(409).json({ error: `Estoque insuficiente de "${v.product_name} ${v.variant_name}" (tem ${v.stock}, pediu ${qty}).` });
    }
    const unitPrice = it.unit_price != null ? parseFloat(it.unit_price) : v.price;
    // Faltou par em mãos? Então essa venda gera encomenda no fornecedor.
    const encomendar = v.on_demand ? Math.max(0, qty - (v.on_hand || 0)) : 0;
    lines.push({ v, qty, unitPrice, lineTotal: money(unitPrice * qty), unitCost: v.cost, encomendar });
  }

  const subtotal = money(lines.reduce((s, l) => s + l.lineTotal, 0));
  const disc = money(Math.max(0, parseFloat(discount) || 0));
  const total = money(Math.max(0, subtotal - disc));
  const costTotal = money(lines.reduce((s, l) => s + l.unitCost * l.qty, 0));
  const margin = money(total - costTotal);
  const status = payment_status === 'pendente' ? 'pendente' : 'pago';
  // Quem vendeu — o nome fica gravado na venda para o histórico não
  // mudar se a pessoa sair da equipe.
  const vendedor = seller_id
    ? db.prepare('SELECT id, name FROM team_members WHERE id = ?').get(seller_id) : null;
  const ts = now();
  const code = 'VN-' + String(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM sales').get().n).padStart(6, '0');

  const saleId = db.transaction(() => {
    const id = db.prepare(`INSERT INTO sales (code, channel, customer_id, customer_name, payment_method, payment_status, paid_at, subtotal, discount, total, cost_total, margin, seller_id, seller_name, items_count, synced_nuvemshop, created_at)
      VALUES (?, 'pdv', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(code, custId, custName, payment_method, status, status === 'pago' ? ts : null, subtotal, disc, total, costTotal, margin,
        vendedor ? vendedor.id : null, vendedor ? vendedor.name : null,
        lines.reduce((s, l) => s + l.qty, 0), ts).lastInsertRowid;
    const insItem = db.prepare(`INSERT INTO sale_items (sale_id, variant_id, name, qty, unit_price, unit_cost, line_total, encomenda) VALUES (?,?,?,?,?,?,?,?)`);
    // Grade do site e par em mãos baixam separados: o site perde a
    // numeração vendida, o estoque real só perde se o par estava aqui.
    // Estoque próprio: os dois números andam juntos (em mãos = estoque).
    const updStock = db.prepare('UPDATE variants SET stock = stock - ?, on_hand = MAX(0, stock - ?), updated_at = ? WHERE id = ?');
    const updHand = db.prepare('UPDATE variants SET on_hand = MAX(0, COALESCE(on_hand,0) - ?), updated_at = ? WHERE id = ?');
    const insMove = db.prepare('INSERT INTO stock_movements (variant_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)');
    const insRem = db.prepare(`INSERT INTO reminders (title, notes, due_date, kind, customer_id, created_at)
      VALUES (?,?,?, 'encomenda', ?, ?)`);
    for (const l of lines) {
      insItem.run(id, l.v.id, `${l.v.product_name} ${l.v.variant_name}`, l.qty, l.unitPrice, l.unitCost, l.lineTotal, l.encomendar);
      if (l.v.on_demand) {
        // A grade do site continua inteira — a numeração segue à venda,
        // porque você consegue repor no fornecedor. Só o par sai daqui.
        updHand.run(l.qty, ts, l.v.id);
        insMove.run(l.v.id, -l.qty, 'venda_pdv', code, ts);
      } else if (l.v.stock_management) {
        updStock.run(l.qty, l.qty, ts, l.v.id); insMove.run(l.v.id, -l.qty, 'venda_pdv', code, ts);
      }
      // Vendeu numeração que não tinha: vira lembrete de buscar hoje.
      if (l.encomendar > 0) {
        insRem.run(
          `Pegar no fornecedor: ${l.v.product_name} ${l.v.variant_name}`,
          `${l.encomendar} peça(s) · venda ${code}${custName ? ' · ' + custName : ''}`,
          ts.slice(0, 10), custId, ts,
        );
      }
    }
    // Funil: toda venda é um atendimento que fechou. Se veio de um
    // atendimento aberto, ele fecha; se ninguém registrou, a venda vira
    // a própria linha — senão a taxa de fechamento sairia menor do que é.
    if (atendimento_id) {
      db.prepare(`UPDATE atendimentos SET stage='vendido', sale_id=?, valor=?, member_id=COALESCE(member_id,?), updated_at=? WHERE id=?`)
        .run(id, total, vendedor ? vendedor.id : null, ts, atendimento_id);
      db.prepare('UPDATE sales SET atendimento_id = ? WHERE id = ?').run(atendimento_id, id);
    } else if (vendedor) {
      const aid = db.prepare(`INSERT INTO atendimentos
        (member_id, customer_id, nome, canal, stage, sale_id, valor, day, created_at)
        VALUES (?,?,?, 'loja', 'vendido', ?,?,?,?)`)
        .run(vendedor.id, custId, custName || '', id, total, ts.slice(0, 10), ts).lastInsertRowid;
      db.prepare('UPDATE sales SET atendimento_id = ? WHERE id = ?').run(aid, id);
    }
    // Caixa: só entra quando PAGO. Fiado vira conta a receber (a própria venda pendente).
    if (status === 'pago') {
      db.prepare(`INSERT INTO financial_entries (type, category, category_id, description, amount, ref, created_at)
        VALUES ('receita','Venda PDV',?,?,?,?,?)`)
        .run(categoryId('Venda PDV', 'receita'), `Venda PDV ${code}`, total, code, ts);
    }
    return id;
  })();

  // Empurra o novo estoque para a Nuvemshop.
  let syncedAll = true; const syncNotes = [];
  if (isLive()) {
    for (const l of lines) {
      if (!l.v.stock_management || !l.v.nuvemshop_product_id || !l.v.nuvemshop_variant_id) continue;
      if (l.v.on_demand) continue;   // a grade do site fica como está
      try { await nuvem.setVariantStock(l.v.nuvemshop_product_id, l.v.nuvemshop_variant_id, Math.max(0, l.v.stock - l.qty)); }
      catch (err) { syncedAll = false; syncNotes.push(`${l.v.product_name} ${l.v.variant_name}: ${err.message}`); }
    }
  } else { syncedAll = false; syncNotes.push('Modo demonstração — estoque não enviado à Nuvemshop.'); }
  const live = isLive();
  db.prepare('UPDATE sales SET synced_nuvemshop=?, sync_note=? WHERE id=?').run(syncedAll && live ? 1 : 0, syncNotes.join(' | ') || null, saleId);

  const encomendas = lines.filter((l) => l.encomendar > 0)
    .map((l) => `${l.v.product_name} ${l.v.variant_name}`);
  res.json({
    ok: true, code, total, margin, payment_status: status, customer_name: custName,
    vendedor: vendedor ? vendedor.name : null,
    mode: live ? 'live' : 'demo', stock_synced: syncedAll && live, notes: syncNotes,
    encomendas,   // o PDV avisa na tela e o lembrete já foi criado
  });
});


// Baixa (marca como pago) — aí sim entra no caixa.
app.post('/api/sales/:id/settle', (req, res) => {
  const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Venda não encontrada.' });
  if (s.payment_status === 'pago') return res.json({ ok: true, already: true });
  const ts = now();
  const method = (req.body && req.body.payment_method) || s.payment_method || '';
  const cat = s.channel === 'site' ? 'Venda Site' : 'Venda PDV';
  db.transaction(() => {
    db.prepare("UPDATE sales SET payment_status='pago', paid_at=?, payment_method=? WHERE id=?").run(ts, method, s.id);
    db.prepare(`INSERT INTO financial_entries (type, category, category_id, description, amount, ref, created_at)
      VALUES ('receita',?,?,?,?,?,?)`).run(cat, categoryId(cat, 'receita'), `Recebimento ${s.code}`, s.total, s.code, ts);
  })();
  res.json({ ok: true, code: s.code, total: s.total });
});

// ==================== PAINEL ====================
app.get('/api/dashboard', (req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const iso = startOfDay.toISOString();
  const today = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(margin),0) AS margin
    FROM sales WHERE created_at >= ? AND payment_status='pago'`).get(iso);
  const ticket = today.orders > 0 ? money(today.revenue / today.orders) : 0;
  const marginPct = today.revenue > 0 ? Math.round((today.margin / today.revenue) * 100) : 0;
  // "Acabando" olha o que existe de verdade. Produto sob encomenda fica
  // de fora: a grade do site não é estoque, e repor é com o fornecedor.
  const BAIXO = `FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.stock_management = 1 AND p.on_demand = 0 AND v.stock <= 4`;
  const lowStock = db.prepare(`SELECT COUNT(*) AS n ${BAIXO}`).get().n;
  const recv = db.prepare(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM sales WHERE payment_status='pendente'`).get();
  const stockVal = db.prepare(`SELECT COALESCE(SUM(${REAL} * v.cost),0) AS v
    FROM variants v LEFT JOIN products p ON p.id = v.product_id WHERE v.stock_management = 1`).get().v;
  const recent = db.prepare('SELECT code, customer_name, payment_method, payment_status, total, created_at, synced_nuvemshop FROM sales ORDER BY id DESC LIMIT 8').all();
  const lowList = db.prepare(`SELECT v.product_name, v.variant_name, v.stock ${BAIXO} ORDER BY v.stock ASC LIMIT 8`).all();
  const pendingList = db.prepare(`SELECT id, code, customer_name, total, created_at FROM sales WHERE payment_status='pendente' ORDER BY created_at ASC LIMIT 8`).all();
  // Lembretes: o que vence hoje ou já passou
  const hojeStr = new Date().toISOString().slice(0, 10);
  const remResumo = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN done=0 AND due_date < ? THEN 1 ELSE 0 END),0) atrasados,
      COALESCE(SUM(CASE WHEN done=0 AND due_date = ? THEN 1 ELSE 0 END),0) hoje,
      COALESCE(SUM(CASE WHEN done=0 THEN 1 ELSE 0 END),0) abertos FROM reminders`).get(hojeStr, hojeStr);
  const remLista = db.prepare(`SELECT r.id, r.title, r.due_date, r.kind, r.amount, c.name customer_name
    FROM reminders r LEFT JOIN customers c ON c.id = r.customer_id
    WHERE r.done = 0 AND (r.due_date IS NULL OR r.due_date <= date(?, '+2 day'))
    ORDER BY COALESCE(r.due_date,'9999-12-31') LIMIT 6`).all(hojeStr);
  // Vendas por origem hoje (PDV x Site)
  const origemHoje = db.prepare(`SELECT CASE WHEN channel='site' THEN 'site' ELSE 'pdv' END o,
    COUNT(*) n, COALESCE(SUM(total),0) t FROM sales
    WHERE payment_status='pago' AND created_at >= ? GROUP BY o`).all(iso);
  res.json({
    mode: isLive() ? 'live' : 'demo',
    reminders: remResumo, reminders_list: remLista, por_origem_hoje: origemHoje,
    revenue_today: money(today.revenue), orders_today: today.orders, ticket, margin_pct: marginPct,
    low_stock: lowStock, stock_value_cost: money(stockVal),
    receivable_total: money(recv.total), receivable_count: recv.n,
    recent_sales: recent, low_stock_list: lowList, pending_list: pendingList,
  });
});

// ==================== SÉRIE DE VENDAS (gráfico) ====================
app.get('/api/sales-series', (req, res) => {
  const days = Math.min(60, Math.max(7, parseInt(req.query.days, 10) || 14));
  const rows = db.prepare(`SELECT date(created_at) d, COALESCE(SUM(total),0) total, COUNT(*) n FROM sales GROUP BY date(created_at)`).all();
  const map = new Map(rows.map((r) => [r.d, r]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const r = map.get(key);
    series.push({ date: key, total: r ? money(r.total) : 0, count: r ? r.n : 0 });
  }
  res.json({ days, series });
});

// ==================== EQUIPE ====================
app.get('/api/team', (req, res) => {
  const rows = db.prepare(`SELECT * FROM team_members
    ORDER BY active DESC, vende DESC, name`).all();
  res.json({
    total: rows.filter((r) => r.active).length,
    vendedores: rows.filter((r) => r.active && r.vende).length,
    membros: rows,
  });
});

app.post('/api/team', (req, res) => {
  const b = req.body || {};
  const nome = String(b.name || '').trim();
  if (!nome) return res.status(400).json({ error: 'Informe o nome.' });
  const dados = [nome, String(b.role || 'Vendedor').trim() || 'Vendedor',
    limpaInsta(b.instagram), String(b.phone || '').trim(),
    b.vende === false ? 0 : 1, b.active === false ? 0 : 1, String(b.note || '').trim()];
  if (b.id) {
    db.prepare(`UPDATE team_members SET name=?, role=?, instagram=?, phone=?, vende=?, active=?, note=? WHERE id=?`)
      .run(...dados, b.id);
    // O nome também aparece nas vendas antigas — mantém coerente.
    db.prepare('UPDATE sales SET seller_name = ? WHERE seller_id = ?').run(nome, b.id);
    return res.json({ ok: true, membro: db.prepare('SELECT * FROM team_members WHERE id = ?').get(b.id) });
  }
  const ex = db.prepare('SELECT id FROM team_members WHERE lower(name) = lower(?)').get(nome);
  if (ex) return res.status(409).json({ error: 'Já existe alguém com esse nome na equipe.' });
  const id = db.prepare(`INSERT INTO team_members (name, role, instagram, phone, vende, active, note, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(...dados, now()).lastInsertRowid;
  res.json({ ok: true, membro: db.prepare('SELECT * FROM team_members WHERE id = ?').get(id) });
});

app.delete('/api/team/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  // Se já vendeu, não some do histórico: só sai de cena.
  const vendeu = db.prepare('SELECT 1 FROM sales WHERE seller_id = ? LIMIT 1').get(m.id);
  if (vendeu) {
    db.prepare('UPDATE team_members SET active = 0 WHERE id = ?').run(m.id);
    return res.json({ ok: true, desativado: true });
  }
  db.prepare('DELETE FROM goals WHERE member_id = ?').run(m.id);
  db.prepare('DELETE FROM team_members WHERE id = ?').run(m.id);
  res.json({ ok: true, apagado: true });
});

// ==================== METAS ====================
// Meta é do mês e por pessoa. O quanto já vendeu vem das vendas com
// vendedor marcado — só conta o que foi pago, não o fiado em aberto.
app.get('/api/metas', (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.query.ym || '') ? req.query.ym : new Date().toISOString().slice(0, 7);
  const ini = `${ym}-01T00:00:00`;
  const [ano, mes] = ym.split('-').map(Number);
  const fim = new Date(ano, mes, 1).toISOString();

  const membros = db.prepare('SELECT * FROM team_members WHERE active = 1 AND vende = 1 ORDER BY name').all();
  const metas = db.prepare('SELECT * FROM goals WHERE ym = ?').all(ym);
  const metaDe = new Map(metas.map((g) => [g.member_id == null ? 'loja' : String(g.member_id), g]));

  const vendasPor = db.prepare(`SELECT seller_id,
      COUNT(*) vendas, COALESCE(SUM(total),0) valor, COALESCE(SUM(margin),0) margem,
      COALESCE(SUM(items_count),0) itens
    FROM sales WHERE payment_status = 'pago' AND created_at >= ? AND created_at < ?
    GROUP BY seller_id`).all(ini, fim);
  const porId = new Map(vendasPor.map((v) => [String(v.seller_id), v]));

  const pessoas = membros.map((m) => {
    const v = porId.get(String(m.id)) || { vendas: 0, valor: 0, margem: 0, itens: 0 };
    const g = metaDe.get(String(m.id));
    const alvo = g ? g.target : 0;
    const pct = alvo > 0 ? Math.round((v.valor / alvo) * 100) : null;
    return {
      id: m.id, nome: m.name, funcao: m.role, instagram: m.instagram,
      meta: money(alvo), vendido: money(v.valor), vendas: v.vendas,
      margem: money(v.margem), itens: v.itens,
      pct, falta: money(Math.max(0, alvo - v.valor)),
      ticket: v.vendas ? money(v.valor / v.vendas) : 0,
    };
  }).sort((a, b) => b.vendido - a.vendido);

  // Total da loja: a meta da loja é a própria, se existir; senão soma as pessoas.
  const gLoja = metaDe.get('loja');
  const vendidoTudo = db.prepare(`SELECT COUNT(*) vendas, COALESCE(SUM(total),0) valor,
      COALESCE(SUM(margin),0) margem FROM sales
    WHERE payment_status = 'pago' AND created_at >= ? AND created_at < ?`).get(ini, fim);
  const semVendedor = db.prepare(`SELECT COUNT(*) vendas, COALESCE(SUM(total),0) valor FROM sales
    WHERE payment_status = 'pago' AND seller_id IS NULL AND created_at >= ? AND created_at < ?`).get(ini, fim);
  const alvoLoja = gLoja ? gLoja.target : pessoas.reduce((s, p) => s + p.meta, 0);

  // Dias: quanto do mês já passou, para saber se o ritmo dá.
  const hoje = new Date();
  const noMes = hoje.toISOString().slice(0, 7) === ym;
  const diasNoMes = new Date(ano, mes, 0).getDate();
  const diaAtual = noMes ? hoje.getDate() : diasNoMes;
  const restam = Math.max(0, diasNoMes - diaAtual);

  res.json({
    ym, dias: { no_mes: diasNoMes, atual: diaAtual, restam, decorrido_pct: Math.round((diaAtual / diasNoMes) * 100) },
    loja: {
      meta: money(alvoLoja), vendido: money(vendidoTudo.valor), vendas: vendidoTudo.vendas,
      margem: money(vendidoTudo.margem),
      pct: alvoLoja > 0 ? Math.round((vendidoTudo.valor / alvoLoja) * 100) : null,
      falta: money(Math.max(0, alvoLoja - vendidoTudo.valor)),
      por_dia: restam > 0 ? money(Math.max(0, alvoLoja - vendidoTudo.valor) / restam) : 0,
      meta_propria: Boolean(gLoja),
    },
    sem_vendedor: { vendas: semVendedor.vendas, valor: money(semVendedor.valor) },
    pessoas,
  });
});

// Define/atualiza a meta de alguém (ou da loja, com member_id nulo).
app.post('/api/metas', (req, res) => {
  const b = req.body || {};
  const ym = /^\d{4}-\d{2}$/.test(b.ym || '') ? b.ym : new Date().toISOString().slice(0, 7);
  const alvo = money(b.target);
  if (!(alvo >= 0)) return res.status(400).json({ error: 'Informe um valor válido.' });
  const mid = b.member_id ? Number(b.member_id) : null;
  if (mid && !db.prepare('SELECT 1 FROM team_members WHERE id = ?').get(mid)) {
    return res.status(400).json({ error: 'Pessoa não encontrada na equipe.' });
  }
  // Zerar a meta é apagá-la — assim não fica meta de R$ 0 atrapalhando.
  if (alvo === 0) {
    db.prepare(`DELETE FROM goals WHERE ym = ? AND ${mid ? 'member_id = ?' : 'member_id IS NULL'}`)
      .run(...(mid ? [ym, mid] : [ym]));
    return res.json({ ok: true, removida: true });
  }
  const existente = db.prepare(`SELECT id FROM goals WHERE ym = ? AND ${mid ? 'member_id = ?' : 'member_id IS NULL'}`)
    .get(...(mid ? [ym, mid] : [ym]));
  if (existente) {
    db.prepare('UPDATE goals SET target = ?, note = ? WHERE id = ?').run(alvo, b.note || '', existente.id);
  } else {
    db.prepare('INSERT INTO goals (member_id, ym, target, note, created_at) VALUES (?,?,?,?,?)')
      .run(mid, ym, alvo, b.note || '', now());
  }
  res.json({ ok: true });
});

// Compras sem comprador identificado (visitante, consumidor final) não
// são pessoa: não entram em ranking, segmento nem régua de contato —
// mas continuam contando no faturamento.
const SQL_PESSOA = `lower(trim(c.name)) NOT IN
  ('não informado','nao informado','não informada','nao informada','sem nome','cliente',
   'cliente do site','consumidor final','consumidor','visitante','guest','n/a','na','-','')`;

// ==================== O FUNIL DA LOJA ====================
// Seis etapas, em ordem. As quatro primeiras são conversa viva; as duas
// últimas fecham a linha. Tudo no sistema que fala de funil olha aqui.
const PIPE = [
  { id: 'novo', label: 'Novo contato', dica: 'Chegou e ainda não foi respondido' },
  { id: 'atendimento', label: 'Atendendo', dica: 'Conversa rolando, descobrindo o que a pessoa quer' },
  { id: 'proposta', label: 'Proposta', dica: 'Mandou peça, foto ou preço' },
  { id: 'fechando', label: 'Fechando', dica: 'Combinou pagamento, entrega ou retirada' },
  { id: 'vendido', label: 'Ganho', dica: 'Virou venda' },
  { id: 'perdido', label: 'Perdido', dica: 'Não deu — com o motivo anotado' },
];
const STAGES = PIPE.map((s) => s.id);
const SQL_ABERTOS = `('novo','atendimento','proposta','fechando')`;
const SQL_PROPOSTA = `('proposta','fechando','vendido')`;   // chegou a virar proposta

// ==================== SONHO → META ====================
// A meta não nasce de planilha, nasce de uma pergunta: o que a pessoa
// quer conquistar e quanto custa. Daí a conta desce sozinha:
//   sonho ÷ comissão   = quanto precisa vender
//   vender ÷ ticket    = quantas vendas
//   vendas ÷ fechamento= quantas propostas
//   propostas ÷ taxa   = quantos atendimentos
//   atendimentos ÷ dia = quantos dias úteis
// A regra que faz isso valer: ticket e conversão são DELE, tirados do
// histórico dele — não da média do time.

// A loja abre de segunda a sábado.
const DIAS_UTEIS_MES = 26;

// Taxas próprias da pessoa. Quando ela ainda não tem histórico, cai para
// a média da loja — e o retorno diz de onde veio, para ninguém confundir
// número real com estimativa.
function taxasDe(memberId, dias = 180) {
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  const desdeDia = desde.slice(0, 10);

  const meu = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM sales
    WHERE seller_id = ? AND payment_status = 'pago' AND created_at >= ?`).get(memberId, desde);
  const loja = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM sales
    WHERE payment_status = 'pago' AND created_at >= ?`).get(desde);

  const fMeu = db.prepare(`SELECT COUNT(*) atend,
      SUM(CASE WHEN stage IN ${SQL_PROPOSTA} THEN 1 ELSE 0 END) prop,
      SUM(CASE WHEN stage = 'vendido' THEN 1 ELSE 0 END) vend
    FROM atendimentos WHERE member_id = ? AND day >= ?`).get(memberId, desdeDia);
  const fLoja = db.prepare(`SELECT COUNT(*) atend,
      SUM(CASE WHEN stage IN ${SQL_PROPOSTA} THEN 1 ELSE 0 END) prop,
      SUM(CASE WHEN stage = 'vendido' THEN 1 ELSE 0 END) vend
    FROM atendimentos WHERE day >= ?`).get(desdeDia);

  // Poucos dados mentem mais do que ajudam: só vale como "dele" com massa.
  const MIN = 5;
  const ticket = meu.n >= MIN ? { v: money(meu.v / meu.n), fonte: 'proprio' }
    : loja.n >= MIN ? { v: money(loja.v / loja.n), fonte: 'loja' }
    : { v: 0, fonte: 'falta' };
  const fech = (fMeu.prop || 0) >= MIN ? { v: Math.round((fMeu.vend / fMeu.prop) * 100), fonte: 'proprio' }
    : (fLoja.prop || 0) >= MIN ? { v: Math.round((fLoja.vend / fLoja.prop) * 100), fonte: 'loja' }
    : { v: 0, fonte: 'falta' };
  const prop = (fMeu.atend || 0) >= MIN ? { v: Math.round((fMeu.prop / fMeu.atend) * 100), fonte: 'proprio' }
    : (fLoja.atend || 0) >= MIN ? { v: Math.round((fLoja.prop / fLoja.atend) * 100), fonte: 'loja' }
    : { v: 0, fonte: 'falta' };

  return { ticket, fechamento: fech, proposta: prop, vendas_periodo: meu.n, funil: fMeu };
}

// A escada. Devolve null quando falta algum número — melhor não mostrar
// conta do que mostrar conta inventada.
function escadaDoSonho(s, t) {
  const ticket = s.ticket_manual > 0 ? s.ticket_manual : t.ticket.v;
  const fech = s.fech_manual > 0 ? s.fech_manual : t.fechamento.v;
  const prop = s.prop_manual > 0 ? s.prop_manual : t.proposta.v;
  // De onde veio cada número — número digitado à mão não pode aparecer
  // como "sem histórico", senão a conta parece pior do que é.
  const fontes = {
    ticket: s.ticket_manual > 0 ? 'manual' : t.ticket.fonte,
    fechamento: s.fech_manual > 0 ? 'manual' : t.fechamento.fonte,
    proposta: s.prop_manual > 0 ? 'manual' : t.proposta.fonte,
  };
  if (!(s.comissao_pct > 0) || !(ticket > 0) || !(fech > 0) || !(prop > 0)) {
    return { pronto: false, ticket, fechamento: fech, proposta: prop, fontes };
  }
  const faturar = money(s.valor / (s.comissao_pct / 100));
  const vendas = Math.ceil(faturar / ticket);
  const propostas = Math.ceil(vendas / (fech / 100));
  const atendimentos = Math.ceil(propostas / (prop / 100));
  const porDia = Math.max(1, s.por_dia || 1);
  const dias = Math.ceil(atendimentos / porDia);
  const prazo = Math.max(1, s.prazo_meses || 12);
  return {
    pronto: true, ticket, fechamento: fech, proposta: prop, fontes,
    faturar, vendas, propostas, atendimentos,
    por_dia: porDia, dias,
    meses: Math.round((dias / DIAS_UTEIS_MES) * 10) / 10,
    // Não existe prazo, existe ritmo: para sair quando ele quer, é isso por dia.
    por_dia_no_prazo: Math.ceil(atendimentos / (prazo * DIAS_UTEIS_MES)),
    no_prazo: dias <= prazo * DIAS_UTEIS_MES,
    meta_mes: money(faturar / prazo),
  };
}

app.get('/api/sonhos', (req, res) => {
  const hoje = new Date().toISOString().slice(0, 10);
  const ym = hoje.slice(0, 7);
  const membros = db.prepare('SELECT * FROM team_members WHERE active = 1 AND vende = 1 ORDER BY name').all();
  const sonhos = db.prepare('SELECT * FROM dreams WHERE active = 1').all();
  const porMembro = new Map(sonhos.map((s) => [String(s.member_id), s]));

  const lista = membros.map((m) => {
    const t = taxasDe(m.id);
    const s = porMembro.get(String(m.id)) || null;
    const hojeF = db.prepare(`SELECT COUNT(*) atend,
        SUM(CASE WHEN stage IN ${SQL_PROPOSTA} THEN 1 ELSE 0 END) prop,
        SUM(CASE WHEN stage = 'vendido' THEN 1 ELSE 0 END) vend
      FROM atendimentos WHERE member_id = ? AND day = ?`).get(m.id, hoje);
    const base = {
      id: m.id, nome: m.name, funcao: m.role, instagram: m.instagram,
      comissao_pct: m.commission_pct || 0,
      taxas: t,
      hoje: { atendimentos: hojeF.atend || 0, propostas: hojeF.prop || 0, vendas: hojeF.vend || 0 },
    };
    if (!s) return { ...base, sonho: null };

    // Quanto do sonho já está no bolso: comissão do que ele vendeu e
    // recebeu desde que o sonho foi escrito.
    const desde = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM sales
      WHERE seller_id = ? AND payment_status = 'pago' AND created_at >= ?`).get(m.id, s.created_at).v;
    const ganho = money(desde * (s.comissao_pct / 100));
    const noMes = db.prepare(`SELECT COALESCE(SUM(total),0) v FROM sales
      WHERE seller_id = ? AND payment_status = 'pago' AND created_at >= ?`).get(m.id, `${ym}-01T00:00:00`).v;
    const conta = escadaDoSonho(s, t);
    return {
      ...base,
      sonho: {
        id: s.id, titulo: s.titulo, valor: money(s.valor), prazo_meses: s.prazo_meses,
        comissao_pct: s.comissao_pct, por_dia: s.por_dia, desde: s.created_at,
        ticket_manual: s.ticket_manual, fech_manual: s.fech_manual, prop_manual: s.prop_manual,
        ganho, falta: money(Math.max(0, s.valor - ganho)),
        pct: s.valor > 0 ? Math.min(100, Math.round((ganho / s.valor) * 100)) : 0,
        comissao_mes: money(noMes * (s.comissao_pct / 100)),
      },
      conta,
    };
  });
  res.json({ dias_uteis_mes: DIAS_UTEIS_MES, pessoas: lista });
});

app.post('/api/sonhos', (req, res) => {
  const b = req.body || {};
  const mid = Number(b.member_id);
  const m = mid ? db.prepare('SELECT * FROM team_members WHERE id = ?').get(mid) : null;
  if (!m) return res.status(400).json({ error: 'Escolha de quem é o sonho.' });
  const titulo = String(b.titulo || '').trim();
  if (!titulo) return res.status(400).json({ error: 'Escreva o que a pessoa quer conquistar.' });
  const valor = money(b.valor);
  if (!(valor > 0)) return res.status(400).json({ error: 'Quanto custa esse sonho?' });
  const com = money(b.comissao_pct);
  if (!(com > 0) || com > 100) return res.status(400).json({ error: 'Informe a comissão em % (ex.: 3).' });

  const opc = (v) => { const n = money(v); return n > 0 ? n : null; };
  const dados = [titulo, valor, Math.max(1, parseInt(b.prazo_meses, 10) || 12), com,
    Math.max(1, parseInt(b.por_dia, 10) || 10), opc(b.ticket_manual), opc(b.fech_manual), opc(b.prop_manual)];

  const ex = db.prepare('SELECT id FROM dreams WHERE member_id = ?').get(mid);
  if (ex) {
    db.prepare(`UPDATE dreams SET titulo=?, valor=?, prazo_meses=?, comissao_pct=?, por_dia=?,
      ticket_manual=?, fech_manual=?, prop_manual=?, active=1, updated_at=? WHERE id=?`).run(...dados, now(), ex.id);
  } else {
    db.prepare(`INSERT INTO dreams (member_id, titulo, valor, prazo_meses, comissao_pct, por_dia,
      ticket_manual, fech_manual, prop_manual, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(mid, ...dados, now());
  }
  // A comissão vive na pessoa: é ela que paga o sonho.
  db.prepare('UPDATE team_members SET commission_pct = ? WHERE id = ?').run(com, mid);
  res.json({ ok: true });
});

app.delete('/api/sonhos/:memberId', (req, res) => {
  db.prepare('DELETE FROM dreams WHERE member_id = ?').run(req.params.memberId);
  res.json({ ok: true });
});

// Transforma a conta do sonho na meta do mês, para os dois números
// falarem a mesma língua.
app.post('/api/sonhos/:memberId/meta', (req, res) => {
  const mid = Number(req.params.memberId);
  const s = db.prepare('SELECT * FROM dreams WHERE member_id = ? AND active = 1').get(mid);
  if (!s) return res.status(404).json({ error: 'Essa pessoa ainda não tem sonho escrito.' });
  const conta = escadaDoSonho(s, taxasDe(mid));
  if (!conta.pronto) return res.status(400).json({ error: 'A conta ainda não fecha — falta ticket ou conversão.' });
  const ym = /^\d{4}-\d{2}$/.test(req.body?.ym || '') ? req.body.ym : new Date().toISOString().slice(0, 7);
  const ex = db.prepare('SELECT id FROM goals WHERE ym = ? AND member_id = ?').get(ym, mid);
  if (ex) db.prepare('UPDATE goals SET target = ?, note = ? WHERE id = ?').run(conta.meta_mes, s.titulo, ex.id);
  else db.prepare('INSERT INTO goals (member_id, ym, target, note, created_at) VALUES (?,?,?,?,?)')
    .run(mid, ym, conta.meta_mes, s.titulo, now());
  res.json({ ok: true, meta: conta.meta_mes });
});

// ==================== FUNIL DE ATENDIMENTO ====================
// Cada pessoa atendida vira uma linha. É o que transforma "achismo de
// conversão" em número — e o que mostra o que cada lead está comprando.
const CANAIS = ['direct', 'whatsapp', 'loja', 'site', 'indicacao'];

app.get('/api/atendimentos', (req, res) => {
  const dias = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
  const cond = ['a.day >= ?']; const args = [desde];
  if (req.query.member_id) { cond.push('a.member_id = ?'); args.push(Number(req.query.member_id)); }
  if (req.query.stage && STAGES.includes(req.query.stage)) { cond.push('a.stage = ?'); args.push(req.query.stage); }
  const linhas = db.prepare(`SELECT a.*, t.name AS vendedor, s.code AS venda_code, s.total AS venda_total
    FROM atendimentos a
    LEFT JOIN team_members t ON t.id = a.member_id
    LEFT JOIN sales s ON s.id = a.sale_id
    WHERE ${cond.join(' AND ')}
    ORDER BY a.created_at DESC LIMIT 400`).all(...args);

  const hoje = new Date().toISOString().slice(0, 10);
  const resumo = db.prepare(`SELECT COUNT(*) atend,
      SUM(CASE WHEN stage IN ${SQL_PROPOSTA} THEN 1 ELSE 0 END) prop,
      SUM(CASE WHEN stage = 'vendido' THEN 1 ELSE 0 END) vend,
      SUM(CASE WHEN stage = 'perdido' THEN 1 ELSE 0 END) perd
    FROM atendimentos WHERE day >= ?${req.query.member_id ? ' AND member_id = ?' : ''}`)
    .get(...(req.query.member_id ? [desde, Number(req.query.member_id)] : [desde]));
  const doDia = db.prepare(`SELECT COUNT(*) n FROM atendimentos WHERE day = ?${req.query.member_id ? ' AND member_id = ?' : ''}`)
    .get(...(req.query.member_id ? [hoje, Number(req.query.member_id)] : [hoje])).n;

  res.json({
    dias,
    resumo: {
      atendimentos: resumo.atend || 0, propostas: resumo.prop || 0,
      vendas: resumo.vend || 0, perdidos: resumo.perd || 0, hoje: doDia,
      taxa_proposta: resumo.atend ? Math.round((resumo.prop / resumo.atend) * 100) : null,
      taxa_fechamento: resumo.prop ? Math.round((resumo.vend / resumo.prop) * 100) : null,
    },
    linhas,
  });
});

app.post('/api/atendimentos', (req, res) => {
  const b = req.body || {};
  const mid = b.member_id ? Number(b.member_id) : null;
  if (mid && !db.prepare('SELECT 1 FROM team_members WHERE id = ?').get(mid)) {
    return res.status(400).json({ error: 'Vendedor não encontrado.' });
  }
  const nome = String(b.nome || '').trim();
  const insta = limpaInsta(b.instagram || (nome.startsWith('@') ? nome : ''));
  if (!nome && !insta) return res.status(400).json({ error: 'Diga quem foi atendido (nome ou @).' });
  const canal = CANAIS.includes(b.canal) ? b.canal : 'direct';
  const stage = STAGES.includes(b.stage) ? b.stage : 'atendimento';
  // Se essa pessoa já é cliente, amarra na ficha dela — é isso que faz a
  // conversa aparecer no histórico e o CRM enxergar o relacionamento.
  let cid = b.customer_id ? Number(b.customer_id) : null;
  if (!cid) {
    const ach = insta
      ? db.prepare('SELECT id FROM customers WHERE lower(instagram) = lower(?)').get(insta)
      : db.prepare('SELECT id FROM customers WHERE lower(trim(name)) = lower(trim(?))').get(nome);
    if (ach) cid = ach.id;
  }
  const ts = now();
  const id = db.prepare(`INSERT INTO atendimentos
    (member_id, customer_id, nome, instagram, canal, querendo, stage, valor, day, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(mid, cid, nome, insta, canal,
      String(b.querendo || '').trim(), stage, money(b.valor), ts.slice(0, 10), ts).lastInsertRowid;
  res.json({ ok: true, atendimento: db.prepare('SELECT * FROM atendimentos WHERE id = ?').get(id) });
});

app.patch('/api/atendimentos/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM atendimentos WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Atendimento não encontrado.' });
  const b = req.body || {};
  const stage = STAGES.includes(b.stage) ? b.stage : a.stage;
  db.prepare(`UPDATE atendimentos SET stage=?, motivo=?, querendo=?, valor=?, nome=?, instagram=?, canal=?,
    member_id=?, updated_at=? WHERE id=?`)
    .run(stage,
      b.motivo !== undefined ? String(b.motivo).trim() : a.motivo,
      b.querendo !== undefined ? String(b.querendo).trim() : a.querendo,
      b.valor !== undefined ? money(b.valor) : a.valor,
      b.nome !== undefined ? String(b.nome).trim() : a.nome,
      b.instagram !== undefined ? limpaInsta(b.instagram) : a.instagram,
      CANAIS.includes(b.canal) ? b.canal : a.canal,
      b.member_id !== undefined ? (b.member_id ? Number(b.member_id) : null) : a.member_id,
      now(), a.id);
  res.json({ ok: true, atendimento: db.prepare('SELECT * FROM atendimentos WHERE id = ?').get(a.id) });
});

app.delete('/api/atendimentos/:id', (req, res) => {
  db.prepare('DELETE FROM atendimentos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== CRM ====================
// A pergunta que o CRM responde não é "quem são meus clientes" — é
// "com quem eu preciso falar hoje, e o que eu digo". Todo o resto
// (segmento, ciclo, ficha) existe para chegar nessa lista.

const CICLO_MIN = 7;        // ninguém compra streetwear a cada 3 dias
const CICLO_PADRAO = 45;    // chute inicial, até a loja ter histórico
const dia = (d) => new Date(d).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.floor((new Date(b) - new Date(a)) / 864e5);
const brl = (n) => 'R$ ' + money(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const SEGMENTOS = [
  { id: 'novo', label: 'Novos', dica: 'Primeira compra nos últimos 30 dias — é agora que vira cliente ou some' },
  { id: 'ativo', label: 'Ativos', dica: 'Comprando dentro do ritmo dele' },
  { id: 'esfriando', label: 'Esfriando', dica: 'Passou do ritmo dele — ainda dá para trazer de volta fácil' },
  { id: 'sumido', label: 'Sumidos', dica: 'Muito além do ritmo — precisa de um bom motivo para voltar' },
  { id: 'perdido', label: 'Perdidos', dica: 'Faz tempo demais — só volta com oferta forte' },
  { id: 'lead', label: 'Leads', dica: 'Foi atendido e nunca comprou' },
  { id: 'cadastro', label: 'Só cadastro', dica: 'Está no sistema e nunca comprou nem foi atendido' },
];

// Junta tudo que o CRM precisa saber de cada pessoa, de uma vez só.
function crmBase() {
  const hoje = dia(Date.now());
  const rows = db.prepare(`
    SELECT c.*,
      COUNT(CASE WHEN s.payment_status IN ('pago','pendente') THEN s.id END) compras,
      COALESCE(SUM(CASE WHEN s.payment_status IN ('pago','pendente') THEN s.total ELSE 0 END),0) gasto,
      COALESCE(SUM(CASE WHEN s.payment_status = 'pendente' THEN s.total ELSE 0 END),0) aberto,
      MIN(CASE WHEN s.payment_status IN ('pago','pendente') THEN s.created_at END) primeira,
      MAX(CASE WHEN s.payment_status IN ('pago','pendente') THEN s.created_at END) ultima
    FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
    WHERE ${SQL_PESSOA}
    GROUP BY c.id`).all();

  const atend = new Map(db.prepare(`SELECT customer_id, COUNT(*) n, MAX(created_at) ultimo
    FROM atendimentos WHERE customer_id IS NOT NULL GROUP BY customer_id`)
    .all().map((r) => [String(r.customer_id), r]));
  const notas = new Map(db.prepare(`SELECT customer_id, MAX(created_at) ultimo,
      MAX(CASE WHEN kind = 'pos_venda' THEN created_at END) ultimo_pos
    FROM crm_notes GROUP BY customer_id`).all().map((r) => [String(r.customer_id), r]));

  // Marca preferida de cada um — é o gancho da conversa.
  const marcas = new Map();
  for (const r of db.prepare(`SELECT s.customer_id cid, p.brand marca, SUM(si.qty) n
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN variants v ON v.id = si.variant_id
      JOIN products p ON p.id = v.product_id
      WHERE s.customer_id IS NOT NULL AND COALESCE(p.brand,'') <> ''
        AND s.payment_status IN ('pago','pendente')
      GROUP BY s.customer_id, p.brand`).all()) {
    const at = marcas.get(String(r.cid));
    if (!at || r.n > at.n) marcas.set(String(r.cid), r);
  }
  // Última peça levada — serve para o pós-venda soar de gente.
  const ultimaPeca = new Map();
  for (const r of db.prepare(`SELECT s.customer_id cid, si.name peca, s.created_at
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.customer_id IS NOT NULL AND s.payment_status IN ('pago','pendente')
      ORDER BY s.created_at ASC`).all()) ultimaPeca.set(String(r.cid), r.peca);

  // Ciclo da loja: a mediana do intervalo entre compras de quem repetiu.
  const ciclos = rows.filter((r) => r.compras >= 2 && r.primeira && r.ultima)
    .map((r) => Math.max(CICLO_MIN, diasEntre(r.primeira, r.ultima) / (r.compras - 1)))
    .sort((a, b) => a - b);
  const cicloLoja = ciclos.length ? Math.round(ciclos[Math.floor(ciclos.length / 2)]) : CICLO_PADRAO;

  // VIP: os 10% que mais gastaram (só faz sentido com alguma massa).
  const gastos = rows.filter((r) => r.compras > 0).map((r) => r.gasto).sort((a, b) => b - a);
  const corteVip = gastos.length >= 8 ? gastos[Math.max(0, Math.ceil(gastos.length * 0.1) - 1)] : Infinity;

  const lista = rows.map((r) => {
    const k = String(r.id);
    const a = atend.get(k), nt = notas.get(k);
    const ciclo = r.compras >= 2 ? Math.round(Math.max(CICLO_MIN, diasEntre(r.primeira, r.ultima) / (r.compras - 1))) : cicloLoja;
    const dias = r.ultima ? diasEntre(r.ultima, Date.now()) : null;
    let seg;
    if (!r.compras) seg = (a && a.n) ? 'lead' : 'cadastro';
    else if (r.compras === 1 && dias <= 30) seg = 'novo';
    else if (dias <= ciclo) seg = 'ativo';
    else if (dias <= ciclo * 1.5) seg = 'esfriando';
    else if (dias <= ciclo * 3) seg = 'sumido';
    else seg = 'perdido';
    return {
      ...r, ciclo, dias, seg,
      vip: r.compras > 0 && r.gasto >= corteVip,
      ticket: r.compras ? money(r.gasto / r.compras) : 0,
      atendimentos: a ? a.n : 0,
      ultimo_contato: nt ? nt.ultimo : null,
      ultimo_pos: nt ? nt.ultimo_pos : null,
      marca: marcas.get(k) ? marcas.get(k).marca : '',
      peca: ultimaPeca.get(k) || '',
    };
  });
  return { hoje, lista, cicloLoja, corteVip };
}

app.get('/api/crm', (req, res) => {
  const base = crmBase();
  const porSeg = new Map(SEGMENTOS.map((s) => [s.id, { ...s, n: 0, valor: 0 }]));
  for (const c of base.lista) {
    const s = porSeg.get(c.seg);
    if (s) { s.n += 1; s.valor = money(s.valor + c.gasto); }
  }
  const pipe = db.prepare(`SELECT stage, COUNT(*) n, COALESCE(SUM(valor),0) valor
    FROM atendimentos GROUP BY stage`).all();
  const pipeMap = new Map(pipe.map((p) => [p.stage, p]));

  const compradores = base.lista.filter((c) => c.compras > 0);
  const recorrentes = compradores.filter((c) => c.compras >= 2).length;
  res.json({
    ciclo_loja: base.cicloLoja,
    numeros: {
      clientes: base.lista.length,
      compradores: compradores.length,
      recorrentes,
      recompra_pct: compradores.length ? Math.round((recorrentes / compradores.length) * 100) : null,
      vips: base.lista.filter((c) => c.vip).length,
      em_risco: base.lista.filter((c) => c.seg === 'esfriando' || c.seg === 'sumido').length,
      a_receber: money(base.lista.reduce((s, c) => s + c.aberto, 0)),
      ticket: compradores.length
        ? money(compradores.reduce((s, c) => s + c.gasto, 0) / compradores.reduce((s, c) => s + c.compras, 0)) : 0,
    },
    segmentos: SEGMENTOS.map((s) => porSeg.get(s.id)),
    pipeline: PIPE.map((p) => ({
      ...p, n: pipeMap.get(p.id) ? pipeMap.get(p.id).n : 0,
      valor: pipeMap.get(p.id) ? money(pipeMap.get(p.id).valor) : 0,
    })),
  });
});

app.get('/api/crm/clientes', (req, res) => {
  const base = crmBase();
  const q = String(req.query.q || '').trim().toLowerCase();
  const seg = String(req.query.seg || '');
  let lista = base.lista;
  if (seg && seg !== 'todos') lista = lista.filter((c) => (seg === 'vip' ? c.vip : c.seg === seg));
  if (q) {
    lista = lista.filter((c) => [c.name, c.instagram, c.phone, c.email, c.tags]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  lista.sort((a, b) => b.gasto - a.gasto || String(a.name).localeCompare(String(b.name)));
  res.json({
    total: lista.length,
    clientes: lista.slice(0, 300).map((c) => ({
      id: c.id, nome: c.name, instagram: c.instagram, phone: c.phone,
      seg: c.seg, vip: c.vip, compras: c.compras, gasto: money(c.gasto),
      aberto: money(c.aberto), ticket: c.ticket, dias: c.dias, ciclo: c.ciclo,
      marca: c.marca, tags: c.tags, next_contact: c.next_contact, no_contact: c.no_contact,
    })),
  });
});

// A ficha 360: tudo que a loja sabe da pessoa, em uma tela.
app.get('/api/crm/cliente/:id', (req, res) => {
  const id = Number(req.params.id);
  const base = crmBase();
  const c = base.lista.find((x) => x.id === id)
    || db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const vendas = db.prepare(`SELECT id, code, total, payment_method, payment_status, created_at, seller_name
    FROM sales WHERE customer_id = ? ORDER BY created_at DESC LIMIT 60`).all(id);
  const itens = db.prepare(`SELECT si.name, si.qty, si.unit_price, s.created_at, s.code,
      COALESCE(p.brand,'') marca, COALESCE(v.variant_name,'') tamanho
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    LEFT JOIN variants v ON v.id = si.variant_id
    LEFT JOIN products p ON p.id = v.product_id
    WHERE s.customer_id = ? AND s.payment_status IN ('pago','pendente')
    ORDER BY s.created_at DESC LIMIT 120`).all(id);
  const conversas = db.prepare(`SELECT a.*, t.name vendedor FROM atendimentos a
    LEFT JOIN team_members t ON t.id = a.member_id
    WHERE a.customer_id = ? ORDER BY a.created_at DESC LIMIT 60`).all(id);
  const notas = db.prepare(`SELECT n.*, t.name vendedor FROM crm_notes n
    LEFT JOIN team_members t ON t.id = n.member_id
    WHERE n.customer_id = ? ORDER BY n.created_at DESC LIMIT 80`).all(id);

  const conta = (campo) => {
    const m = new Map();
    for (const i of itens) { const k = i[campo]; if (!k) continue; m.set(k, (m.get(k) || 0) + i.qty); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([nome, n]) => ({ nome, n }));
  };

  // Linha do tempo única: compra, conversa e anotação misturadas em ordem.
  const linha = [
    ...vendas.map((v) => ({ t: 'venda', quando: v.created_at, titulo: `${v.code} · ${brl(v.total)}`,
      texto: `${v.payment_status === 'pendente' ? 'Fiado em aberto' : 'Pago'}${v.payment_method ? ' · ' + v.payment_method : ''}${v.seller_name ? ' · ' + v.seller_name : ''}`, ref: v.id })),
    ...conversas.map((a) => ({ t: 'conversa', quando: a.created_at,
      titulo: (PIPE.find((p) => p.id === a.stage) || { label: a.stage }).label,
      texto: [a.querendo, a.motivo, a.vendedor].filter(Boolean).join(' · '), ref: a.id })),
    ...notas.map((n) => ({ t: n.kind, quando: n.created_at, titulo: n.kind,
      texto: [n.body, n.vendedor].filter(Boolean).join(' · '), ref: n.id, nota: true })),
  ].sort((a, b) => String(b.quando).localeCompare(String(a.quando)));

  res.json({
    cliente: {
      id: c.id, nome: c.name, instagram: c.instagram || '', phone: c.phone || '', email: c.email || '',
      note: c.note || '', birthday: c.birthday || '', tags: c.tags || '', origin: c.origin || '',
      size_top: c.size_top || '', size_pants: c.size_pants || '', size_shoe: c.size_shoe || '',
      owner_id: c.owner_id, next_contact: c.next_contact || '', last_contact: c.last_contact || '',
      no_contact: !!c.no_contact, da_loja: !!c.nuvemshop_customer_id,
    },
    numeros: {
      seg: c.seg || 'cadastro', vip: !!c.vip, compras: c.compras || 0, gasto: money(c.gasto || 0),
      aberto: money(c.aberto || 0), ticket: c.ticket || 0, ciclo: c.ciclo || base.cicloLoja,
      dias: c.dias == null ? null : c.dias, primeira: c.primeira || null, ultima: c.ultima || null,
      atendimentos: c.atendimentos || 0,
      previsao: c.ultima ? dia(new Date(c.ultima).getTime() + (c.ciclo || base.cicloLoja) * 864e5) : null,
    },
    gosta: { marcas: conta('marca'), tamanhos: conta('tamanho'), pecas: conta('name') },
    linha: linha.slice(0, 80),
    vendas,
  });
});

app.patch('/api/crm/cliente/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const b = req.body || {};
  const txt = (k, atual) => (b[k] !== undefined ? String(b[k] || '').trim() : atual);
  const dt = (k, atual) => {
    if (b[k] === undefined) return atual;
    const v = String(b[k] || '').trim();
    if (!v) return null;
    return /^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{2}-\d{2}$/.test(v) ? v : atual;
  };
  db.prepare(`UPDATE customers SET birthday=?, size_top=?, size_pants=?, size_shoe=?, tags=?,
    origin=?, owner_id=?, next_contact=?, no_contact=?, note=? WHERE id=?`)
    .run(dt('birthday', c.birthday), txt('size_top', c.size_top), txt('size_pants', c.size_pants),
      txt('size_shoe', c.size_shoe), txt('tags', c.tags), txt('origin', c.origin),
      b.owner_id !== undefined ? (b.owner_id ? Number(b.owner_id) : null) : c.owner_id,
      dt('next_contact', c.next_contact),
      b.no_contact !== undefined ? (b.no_contact ? 1 : 0) : c.no_contact,
      txt('note', c.note), c.id);
  res.json({ ok: true });
});

// Registrar que falou com a pessoa. É o que tira ela da fila de hoje e
// já deixa marcado quando é a próxima conversa.
app.post('/api/crm/cliente/:id/contato', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const b = req.body || {};
  const kinds = ['nota', 'direct', 'whatsapp', 'ligacao', 'visita', 'pos_venda', 'cobranca'];
  const kind = kinds.includes(b.kind) ? b.kind : 'nota';
  const ts = now();
  db.prepare(`INSERT INTO crm_notes (customer_id, member_id, kind, body, motivo, created_at)
    VALUES (?,?,?,?,?,?)`).run(c.id, b.member_id ? Number(b.member_id) : null, kind,
    String(b.body || '').trim(), String(b.motivo || '').trim(), ts);

  // "Adiar" é só reagendar: some da fila hoje, volta no dia marcado.
  let proximo = null;
  if (b.next_contact) proximo = String(b.next_contact).slice(0, 10);
  else if (b.adiar_dias) proximo = dia(Date.now() + Math.min(365, Math.max(1, Number(b.adiar_dias))) * 864e5);
  db.prepare('UPDATE customers SET last_contact = ?, next_contact = ? WHERE id = ?')
    .run(ts, proximo, c.id);
  res.json({ ok: true, next_contact: proximo });
});

app.delete('/api/crm/nota/:id', (req, res) => {
  db.prepare('DELETE FROM crm_notes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== MENSAGENS AO CLIENTE ====================
// Duas coisas que a loja perde por esquecimento: carrinho abandonado
// que ninguém resgata, e cliente sem notícia do próprio pedido.
// O sistema monta a mensagem e põe na fila; QUEM ENVIA é uma pessoa,
// com um toque. Enviar sozinho exige a API oficial do WhatsApp — está
// preparado para isso, mas não se liga sem o dono contratar.

const MODELOS = [
  { id: 'carrinho_1', label: 'Carrinho abandonado — primeiro toque', evento: 'carrinho',
    atraso_horas: 6, ordem: 1,
    corpo: 'Oi {nome}! Vi que você deixou {itens} no carrinho lá na VN 👀\n'
      + 'Ainda tenho aqui. Quer que eu separe?\n{link}' },
  { id: 'carrinho_2', label: 'Carrinho abandonado — segundo toque', evento: 'carrinho',
    atraso_horas: 48, ordem: 2,
    corpo: 'E aí {nome}, consegue fechar hoje? Se rolar dúvida de tamanho me chama que eu te ajudo.\n{link}' },
  { id: 'pedido_pago', label: 'Pagamento confirmado', evento: 'pago', atraso_horas: 0, ordem: 3,
    corpo: 'Fechou, {nome}! Pagamento do pedido {pedido} confirmado ✅\n'
      + 'Já vou separar e te aviso quando sair.' },
  { id: 'pedido_enviado', label: 'Pedido enviado', evento: 'enviado', atraso_horas: 0, ordem: 4,
    corpo: '{nome}, seu pedido {pedido} saiu para entrega 📦\nQualquer coisa é só chamar aqui.' },
  { id: 'pedido_retirar', label: 'Pronto para retirar', evento: 'retirar', atraso_horas: 0, ordem: 5,
    corpo: '{nome}, seu pedido {pedido} está separado e te esperando na loja 🛍️' },
];

function semearModelos() {
  const ins = db.prepare(`INSERT OR IGNORE INTO msg_templates
    (id, label, evento, corpo, ativo, atraso_horas, ordem, updated_at) VALUES (?,?,?,?,1,?,?,?)`);
  const ts = now();
  for (const m of MODELOS) ins.run(m.id, m.label, m.evento, m.corpo, m.atraso_horas, m.ordem, ts);
}

// Troca as variáveis pelo que a loja sabe. O que não existir vira vazio,
// nunca "{nome}" na cara do cliente.
function preencher(corpo, v) {
  return String(corpo || '')
    .replace(/\{nome\}/g, (v.nome || '').split(' ')[0] || 'tudo bem')
    .replace(/\{loja\}/g, 'VN Store')
    .replace(/\{valor\}/g, v.valor != null ? brl(v.valor) : '')
    .replace(/\{itens\}/g, v.itens || 'as peças')
    .replace(/\{pedido\}/g, v.pedido || '')
    .replace(/\{link\}/g, v.link || '')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .trim();
}

// Traz os carrinhos abandonados e marca os que já viraram pedido.
async function sincronizarCarrinhos(dias = 30) {
  if (!isLive()) return { skipped: true };
  const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
  let lista;
  try { lista = await nuvem.listAbandonedCheckouts({ since: desde }); }
  catch (err) {
    // Loja em plano que não expõe o recurso: registra e segue a vida.
    setSetting('carrinhos_erro', err.message);
    return { erro: err.message };
  }
  setSetting('carrinhos_erro', '');

  const ins = db.prepare(`INSERT INTO carts
    (ns_checkout_id, customer_id, nome, phone, email, total, itens, url, ns_created_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(ns_checkout_id) DO UPDATE SET
      total = excluded.total, itens = excluded.itens, url = excluded.url,
      phone = excluded.phone, email = excluded.email, updated_at = excluded.created_at`);
  const achaCli = db.prepare(`SELECT id FROM customers
    WHERE (? <> '' AND lower(email) = lower(?)) OR (? <> '' AND phone = ?) LIMIT 1`);
  const ts = now();
  let novos = 0;

  db.transaction(() => {
    for (const c of lista) {
      const id = String(c.id ?? c.token ?? '');
      if (!id) continue;
      // A loja muda nome de campo entre versões — aceita o que vier.
      const ct = c.contact || c.customer || {};
      const nome = String(c.contact_name || ct.name || c.customer_name || '').trim();
      const fone = String(c.contact_phone || ct.phone || c.phone || '').trim();
      const mail = String(c.contact_email || ct.email || c.email || '').trim();
      const prods = Array.isArray(c.products) ? c.products : (Array.isArray(c.items) ? c.items : []);
      const itens = prods.map((p) => {
        const n = p.name || (p.product && p.product.name) || 'peça';
        const q = parseInt(p.quantity, 10) || 1;
        return q > 1 ? `${q}x ${n}` : n;
      }).join(', ');
      const url = String(c.abandoned_checkout_url || c.checkout_url || c.url || '').trim();
      const quando = c.created_at ? new Date(c.created_at).toISOString() : ts;
      const existia = db.prepare('SELECT 1 FROM carts WHERE ns_checkout_id = ?').get(id);
      const cli = (mail || fone) ? achaCli.get(mail, mail, fone, fone) : null;
      ins.run(id, cli ? cli.id : null, nome, fone, mail,
        money(parseFloat(c.total) || 0), itens, url, quando, ts);
      if (!existia) novos += 1;
    }
  })();

  // Carrinho vira "recuperado" quando aparece um pedido da mesma pessoa
  // depois dele — não adianta cobrar quem já comprou.
  // Casa pelo cliente do pedido, ou pelo e-mail do cadastro dele.
  const MESMA_PESSOA = `s.channel = 'site' AND s.created_at >= carts.ns_created_at
      AND ((carts.customer_id IS NOT NULL AND s.customer_id = carts.customer_id)
        OR (carts.email <> '' AND lower(COALESCE(cu.email,'')) = lower(carts.email)))`;
  const fecha = db.prepare(`UPDATE carts SET recuperado = 1, sale_id = (
      SELECT s.id FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
      WHERE ${MESMA_PESSOA} ORDER BY s.created_at LIMIT 1)
    WHERE recuperado = 0 AND EXISTS (
      SELECT 1 FROM sales s LEFT JOIN customers cu ON cu.id = s.customer_id
      WHERE ${MESMA_PESSOA})`);
  const rec = fecha.run().changes;
  return { novos, total: lista.length, recuperados: rec };
}

// Monta a fila. "ref" é única por evento, então rodar isso mil vezes
// nunca duplica mensagem.
function gerarMensagens() {
  semearModelos();
  const modelos = db.prepare('SELECT * FROM msg_templates WHERE ativo = 1').all();
  const porEvento = (e) => modelos.filter((m) => m.evento === e).sort((a, b) => a.ordem - b.ordem);
  const ins = db.prepare(`INSERT OR IGNORE INTO messages
    (ref, tipo, template_id, customer_id, cart_id, sale_id, nome, phone, corpo, status, agendado_para, created_at)
    VALUES (?,?,?,?,?,?,?,?,?, 'pendente', ?, ?)`);
  const ts = now();
  let n = 0;

  // --- carrinhos abandonados ---
  const carrinhos = db.prepare(`SELECT * FROM carts
    WHERE recuperado = 0 AND COALESCE(phone,'') <> '' AND ns_created_at >= ?`)
    .all(new Date(Date.now() - 30 * 864e5).toISOString());
  for (const m of porEvento('carrinho')) {
    for (const c of carrinhos) {
      const quando = new Date(new Date(c.ns_created_at).getTime() + m.atraso_horas * 36e5);
      if (quando > new Date()) continue;   // ainda não é hora
      const corpo = preencher(m.corpo, { nome: c.nome, valor: c.total, itens: c.itens, link: c.url });
      n += ins.run(`CART-${c.ns_checkout_id}-${m.id}`, 'carrinho', m.id, c.customer_id, c.id, null,
        c.nome, c.phone, corpo, quando.toISOString(), ts).changes;
    }
  }

  // --- status do pedido ---
  // Cada transição gera no máximo uma mensagem, para sempre.
  const pedidos = db.prepare(`SELECT s.*, c.phone AS cli_phone, c.name AS cli_nome FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.channel = 'site' AND s.created_at >= ?`)
    .all(new Date(Date.now() - 45 * 864e5).toISOString());
  for (const p of pedidos) {
    const fone = String(p.cli_phone || '').trim();
    if (!fone) continue;
    const nome = p.cli_nome || p.customer_name || '';
    // Lista fechada de propósito: "unfulfilled" contém "fulfilled", e um
    // teste por pedaço avisaria entrega de pedido que não saiu da loja.
    const ship = String(p.ns_shipping_status || '').trim().toLowerCase();
    const enviado = ['fulfilled', 'shipped', 'enviado', 'despachado', 'delivered', 'entregue'].includes(ship);
    const retirada = String(p.ns_shipping_type || '') === 'retirada'
      || /pickup|retir/i.test(String(p.ns_shipping_type || ''));
    const estados = [
      { evento: 'pago', quando: p.payment_status === 'pago' },
      { evento: 'retirar', quando: p.payment_status === 'pago' && retirada && enviado },
      { evento: 'enviado', quando: enviado && !retirada },
    ];
    for (const e of estados) {
      if (!e.quando) continue;
      for (const m of porEvento(e.evento)) {
        const corpo = preencher(m.corpo, { nome, valor: p.total, pedido: p.code });
        n += ins.run(`PED-${p.code}-${m.id}`, 'pedido', m.id, p.customer_id, null, p.id,
          nome, fone, corpo, ts, ts).changes;
      }
    }
  }
  return n;
}

app.get('/api/mensagens', (req, res) => {
  semearModelos();
  const agora = now();
  const status = ['pendente', 'enviado', 'descartado'].includes(req.query.status)
    ? req.query.status : 'pendente';
  const linhas = db.prepare(`SELECT m.*, t.label AS modelo FROM messages m
    LEFT JOIN msg_templates t ON t.id = m.template_id
    WHERE m.status = ?${status === 'pendente' ? ' AND COALESCE(m.agendado_para, m.created_at) <= ?' : ''}
    ORDER BY m.created_at DESC LIMIT 200`)
    .all(...(status === 'pendente' ? [status, agora] : [status]));

  const cont = db.prepare(`SELECT status, COUNT(*) n FROM messages GROUP BY status`).all();
  const contagem = { pendente: 0, enviado: 0, descartado: 0 };
  for (const c of cont) contagem[c.status] = c.n;

  const carrinhos = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM carts
    WHERE recuperado = 0 AND ns_created_at >= ?`)
    .get(new Date(Date.now() - 30 * 864e5).toISOString());
  const recuperados = db.prepare(`SELECT COUNT(*) n FROM carts WHERE recuperado = 1 AND ns_created_at >= ?`)
    .get(new Date(Date.now() - 30 * 864e5).toISOString()).n;

  res.json({
    status, linhas, contagem,
    carrinhos: { abertos: carrinhos.n, valor: money(carrinhos.v), recuperados },
    modelos: db.prepare('SELECT * FROM msg_templates ORDER BY ordem, id').all(),
    erro_carrinhos: getSetting('carrinhos_erro') || '',
    // Enquanto não houver API oficial contratada, quem envia é gente.
    envio_automatico: false,
  });
});

// Gera a fila na hora (o tique automático também faz isso sozinho).
app.post('/api/mensagens/atualizar', async (req, res) => {
  // Procurar novidades tem que olhar os dois lados: carrinho largado e
  // pedido que mudou de status. Senão o botão mente pela metade.
  let pedidos = null, carrinhos = null;
  try { pedidos = await sincronizarPedidos(); } catch (err) { pedidos = { erro: err.message }; }
  try { carrinhos = await sincronizarCarrinhos(); } catch (err) { carrinhos = { erro: err.message }; }
  const geradas = gerarMensagens();
  res.json({ ok: true, pedidos, carrinhos, geradas });
});

app.post('/api/mensagens/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Mensagem não encontrada.' });
  const acao = req.body?.acao;
  if (acao === 'descartar') {
    db.prepare("UPDATE messages SET status = 'descartado' WHERE id = ?").run(m.id);
    return res.json({ ok: true });
  }
  if (acao !== 'enviado') return res.status(400).json({ error: 'Ação inválida.' });
  const ts = now();
  const quem = req.body?.member_id ? Number(req.body.member_id) : null;
  db.transaction(() => {
    db.prepare("UPDATE messages SET status='enviado', enviado_em=?, enviado_por=? WHERE id=?")
      .run(ts, quem, m.id);
    // Vira história do cliente — o CRM tem que saber que falamos com ele.
    if (m.customer_id) {
      db.prepare(`INSERT INTO crm_notes (customer_id, member_id, kind, body, motivo, created_at)
        VALUES (?,?, 'whatsapp', ?, ?, ?)`)
        .run(m.customer_id, quem, m.corpo.slice(0, 300),
          m.tipo === 'carrinho' ? 'carrinho abandonado' : 'status do pedido', ts);
      db.prepare('UPDATE customers SET last_contact = ? WHERE id = ?').run(ts, m.customer_id);
    }
  })();
  res.json({ ok: true });
});

app.post('/api/mensagens/modelo/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM msg_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Modelo não encontrado.' });
  const b = req.body || {};
  const corpo = b.corpo !== undefined ? String(b.corpo).trim() : t.corpo;
  if (!corpo) return res.status(400).json({ error: 'A mensagem não pode ficar vazia.' });
  const h = b.atraso_horas !== undefined ? Math.max(0, Math.min(720, parseInt(b.atraso_horas, 10) || 0)) : t.atraso_horas;
  db.prepare('UPDATE msg_templates SET corpo=?, ativo=?, atraso_horas=?, updated_at=? WHERE id=?')
    .run(corpo, b.ativo === false ? 0 : 1, h, now(), t.id);
  res.json({ ok: true });
});

// ==================== VISÃO DO NEGÓCIO ====================
// Identidade (quem somos) + o Business Model Canvas, nos nove blocos do
// modelo do Osterwalder. É documento de pensamento: o sistema não
// inventa nada aqui — só oferece o que ele já sabe de fato.
const CANVAS = [
  { id: 'parcerias', label: 'Parcerias principais', area: 'canvas',
    pergunta: 'Quem são os parceiros e fornecedores sem os quais a loja não roda?',
    exemplos: 'Fornecedores, fábrica, transportadora, loja parceira, influenciador' },
  { id: 'atividades', label: 'Atividades-chave', area: 'canvas',
    pergunta: 'O que a loja precisa fazer todo dia para a proposta de valor existir?',
    exemplos: 'Garimpar peça, fotografar, postar, atender no direct, embalar' },
  { id: 'recursos', label: 'Recursos principais', area: 'canvas',
    pergunta: 'O que você precisa ter para entregar isso? Gente, coisa, marca, dinheiro.',
    exemplos: 'Estoque, ponto, o @ da loja, equipe, capital de giro, fornecedor fiel' },
  { id: 'proposta', label: 'Proposta de valor', area: 'canvas',
    pergunta: 'Que problema você resolve, e por que comprariam de você e não do vizinho?',
    exemplos: 'Peça original, curadoria, entrega no mesmo dia, atendimento humano' },
  { id: 'relacionamento', label: 'Relacionamento', area: 'canvas',
    pergunta: 'Como você conquista, mantém e faz o cliente voltar?',
    exemplos: 'Direct pessoal, pós-venda, fiado para cliente antigo, lançamento antes' },
  { id: 'canais', label: 'Canais', area: 'canvas',
    pergunta: 'Por onde o cliente descobre, escolhe, compra e recebe?',
    exemplos: 'Instagram, WhatsApp, loja física, site, entrega' },
  { id: 'segmentos', label: 'Segmentos de clientes', area: 'canvas',
    pergunta: 'Para quem você faz isso? Descreva as pessoas, não "todo mundo".',
    exemplos: 'Jovem de 16 a 25 do bairro, revendedor, quem compra presente' },
  { id: 'custos', label: 'Estrutura de custos', area: 'base',
    pergunta: 'Para onde o dinheiro vai? O que é fixo e o que cresce com a venda?',
    exemplos: 'Mercadoria, aluguel, anúncio, embalagem, taxa da maquininha, salário' },
  { id: 'receitas', label: 'Fontes de receita', area: 'base',
    pergunta: 'De onde entra dinheiro, e como o cliente prefere pagar?',
    exemplos: 'Venda no balcão, venda no site, encomenda, atacado' },
];
const TEXTOS = [
  { id: 'missao', label: 'Missão', pergunta: 'Por que a loja existe? Em uma frase.' },
  { id: 'visao', label: 'Visão', pergunta: 'Onde ela precisa chegar? Coloque prazo.' },
  { id: 'manifesto', label: 'Como a gente joga', pergunta: 'O jeito da casa: como atende, como fala, o que nunca faz.' },
];

app.get('/api/canvas', (req, res) => {
  const textos = {};
  for (const r of db.prepare('SELECT chave, valor FROM canvas_texts').all()) textos[r.chave] = r.valor;
  const itens = db.prepare('SELECT * FROM canvas_items ORDER BY bloco, ordem, id').all();
  const doBloco = (b) => itens.filter((x) => x.bloco === b)
    .map((x) => ({ id: x.id, texto: x.texto, nota: x.nota || '' }));

  // Só o que o sistema mede de verdade — o resto é pensamento do dono.
  const d90 = new Date(Date.now() - 90 * 864e5).toISOString();
  const ym = new Date().toISOString().slice(0, 7);
  const vendas = db.prepare(`SELECT channel, COUNT(*) n, COALESCE(SUM(total),0) v FROM sales
    WHERE payment_status <> 'cancelado' AND created_at >= ? GROUP BY channel`).all(d90);
  const totalV = vendas.reduce((s, x) => s + x.v, 0);
  const pessoas = db.prepare(`SELECT COUNT(*) n FROM customers c WHERE ${SQL_PESSOA}`).get().n;
  const recompra = db.prepare(`SELECT COUNT(*) n FROM (
    SELECT customer_id FROM sales WHERE customer_id IS NOT NULL AND payment_status <> 'cancelado'
    GROUP BY customer_id HAVING COUNT(*) > 1)`).get().n;
  const despesa = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM financial_entries
    WHERE type = 'despesa' AND substr(created_at,1,7) = ?`).get(ym).v;
  const canais = db.prepare(`SELECT canal, COUNT(*) n FROM atendimentos WHERE day >= ?
    GROUP BY canal ORDER BY n DESC`).all(d90.slice(0, 10));

  const real = {
    receitas: totalV > 0
      ? vendas.map((x) => `${x.channel === 'site' ? 'Site' : 'Balcão'}: ${brl(x.v)} (${Math.round((x.v / totalV) * 100)}%)`).join(' · ')
      : null,
    custos: despesa > 0 ? `${brl(despesa)} de despesa lançada neste mês` : null,
    segmentos: pessoas > 0 ? `${pessoas} pessoa(s) na base · ${recompra} já compraram mais de uma vez` : null,
    canais: canais.length ? canais.map((c) => `${c.canal}: ${c.n}`).join(' · ') : null,
  };

  const preenchidos = CANVAS.filter((b) => doBloco(b.id).length).length
    + TEXTOS.filter((t) => (textos[t.id] || '').trim()).length;
  res.json({
    textos: TEXTOS.map((t) => ({ ...t, valor: textos[t.id] || '' })),
    valores: doBloco('valores'),
    blocos: CANVAS.map((b) => ({ ...b, itens: doBloco(b.id), real: real[b.id] || null })),
    completo: Math.round((preenchidos / (CANVAS.length + TEXTOS.length)) * 100),
  });
});

app.post('/api/canvas/texto', (req, res) => {
  const b = req.body || {};
  const chave = String(b.chave || '').trim();
  if (!TEXTOS.some((t) => t.id === chave)) return res.status(400).json({ error: 'Campo desconhecido.' });
  db.prepare(`INSERT INTO canvas_texts (chave, valor, updated_at) VALUES (?,?,?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at`)
    .run(chave, String(b.valor || '').trim(), now());
  res.json({ ok: true });
});

app.post('/api/canvas/item', (req, res) => {
  const b = req.body || {};
  const bloco = String(b.bloco || '').trim();
  if (bloco !== 'valores' && !CANVAS.some((x) => x.id === bloco)) {
    return res.status(400).json({ error: 'Bloco desconhecido.' });
  }
  const texto = String(b.texto || '').trim();
  if (!texto) return res.status(400).json({ error: 'Escreva alguma coisa.' });
  const nota = String(b.nota || '').trim();
  if (b.id) {
    db.prepare('UPDATE canvas_items SET texto = ?, nota = ? WHERE id = ?').run(texto, nota, b.id);
    return res.json({ ok: true, id: Number(b.id) });
  }
  const prox = db.prepare('SELECT COALESCE(MAX(ordem),-1)+1 n FROM canvas_items WHERE bloco = ?').get(bloco).n;
  const id = db.prepare('INSERT INTO canvas_items (bloco, ordem, texto, nota, created_at) VALUES (?,?,?,?,?)')
    .run(bloco, prox, texto, nota, now()).lastInsertRowid;
  res.json({ ok: true, id });
});

app.delete('/api/canvas/item/:id', (req, res) => {
  db.prepare('DELETE FROM canvas_items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== MAPA DA ESTRATÉGIA ====================
// O quadro mostra as conversas de hoje; o mapa mostra o CAMINHO que a
// loja construiu para uma pessoa chegar até ali. O desenho é do dono —
// o sistema só preenche os números que ele sabe de onde tirar.
const FONTES = [
  { id: '', label: 'Você digita o número' },
  { id: 'canal:direct', label: 'Atendimentos vindos do Direct' },
  { id: 'canal:whatsapp', label: 'Atendimentos vindos do WhatsApp' },
  { id: 'canal:loja', label: 'Atendimentos na loja' },
  { id: 'canal:site', label: 'Atendimentos vindos do site' },
  { id: 'canal:indicacao', label: 'Atendimentos por indicação' },
  { id: 'etapa:atendidos', label: 'Todo mundo atendido' },
  { id: 'etapa:proposta', label: 'Chegaram a receber proposta' },
  { id: 'etapa:vendido', label: 'Fecharam a compra' },
  { id: 'venda:pdv', label: 'Vendas no balcão' },
  { id: 'venda:site', label: 'Vendas pelo site' },
  { id: 'cliente:novo', label: 'Clientes que compraram pela 1ª vez' },
];

// Desenho inicial: o caminho comum de uma loja de streetwear. Serve para
// ele ter o que editar em vez de encarar uma tela em branco.
function semearMapa() {
  if (db.prepare('SELECT COUNT(*) n FROM funnel_levels').get().n > 0) return;
  const ts = now();
  const nivel = db.prepare('INSERT INTO funnel_levels (ordem, label, created_at) VALUES (?,?,?)');
  const no = db.prepare(`INSERT INTO funnel_nodes (level_id, ordem, label, fonte, valor, meta, nota, created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const plano = [
    ['Descoberta', [['Anúncio', ''], ['Reels e orgânico', ''], ['Indicação', 'canal:indicacao']]],
    ['Perfil no Instagram', [['Visitas ao perfil', ''], ['Cliques na bio', '']]],
    ['Conversa', [['Direct', 'canal:direct'], ['WhatsApp', 'canal:whatsapp'], ['Veio na loja', 'canal:loja']]],
    ['Proposta', [['Mandou peça ou preço', 'etapa:proposta']]],
    ['Venda', [['Fechou', 'etapa:vendido'], ['Pelo site', 'venda:site']]],
  ];
  db.transaction(() => {
    plano.forEach(([label, nos], i) => {
      const lid = nivel.run(i, label, ts).lastInsertRowid;
      nos.forEach(([nome, fonte], j) => no.run(lid, j, nome, fonte, null, null, '', ts));
    });
  })();
}

function numeroDaFonte(fonte, desdeISO, desdeDia) {
  if (!fonte) return null;
  const [tipo, chave] = String(fonte).split(':');
  if (tipo === 'canal') {
    return db.prepare('SELECT COUNT(*) n FROM atendimentos WHERE canal = ? AND day >= ?').get(chave, desdeDia).n;
  }
  if (tipo === 'etapa') {
    if (chave === 'atendidos') return db.prepare('SELECT COUNT(*) n FROM atendimentos WHERE day >= ?').get(desdeDia).n;
    if (chave === 'proposta') {
      return db.prepare(`SELECT COUNT(*) n FROM atendimentos WHERE stage IN ${SQL_PROPOSTA} AND day >= ?`).get(desdeDia).n;
    }
    if (chave === 'vendido') return db.prepare("SELECT COUNT(*) n FROM atendimentos WHERE stage = 'vendido' AND day >= ?").get(desdeDia).n;
  }
  if (tipo === 'venda') {
    return db.prepare(`SELECT COUNT(*) n FROM sales WHERE channel = ? AND payment_status <> 'cancelado' AND created_at >= ?`)
      .get(chave, desdeISO).n;
  }
  if (tipo === 'cliente' && chave === 'novo') {
    return db.prepare(`SELECT COUNT(*) n FROM (
      SELECT customer_id FROM sales WHERE customer_id IS NOT NULL AND payment_status <> 'cancelado'
      GROUP BY customer_id HAVING MIN(created_at) >= ?)`).get(desdeISO).n;
  }
  return null;
}

app.get('/api/mapa', (req, res) => {
  semearMapa();
  const dias = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const desdeISO = new Date(Date.now() - dias * 864e5).toISOString();
  const desdeDia = desdeISO.slice(0, 10);

  const niveis = db.prepare('SELECT * FROM funnel_levels ORDER BY ordem, id').all();
  const nos = db.prepare('SELECT * FROM funnel_nodes ORDER BY ordem, id').all();

  const montado = niveis.map((n) => {
    const meus = nos.filter((x) => x.level_id === n.id).map((x) => {
      const auto = numeroDaFonte(x.fonte, desdeISO, desdeDia);
      const valor = auto != null ? auto : (x.valor != null ? x.valor : null);
      return {
        id: x.id, label: x.label, fonte: x.fonte || '', nota: x.nota || '',
        meta: x.meta, valor, automatico: auto != null, manual: x.valor,
        pct_meta: x.meta > 0 && valor != null ? Math.round((valor / x.meta) * 100) : null,
      };
    });
    const soma = meus.reduce((s, x) => s + (x.valor || 0), 0);
    const temNumero = meus.some((x) => x.valor != null);
    return { id: n.id, label: n.label, ordem: n.ordem, nos: meus, total: temNumero ? soma : null };
  });

  // A conversão entre um nível e o seguinte — é o que mostra onde vaza.
  for (let i = 0; i < montado.length - 1; i += 1) {
    const a = montado[i].total, b = montado[i + 1].total;
    montado[i].conversao = (a > 0 && b != null) ? Math.round((b / a) * 1000) / 10 : null;
  }
  res.json({ dias, fontes: FONTES, niveis: montado });
});

app.post('/api/mapa/nivel', (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Dê um nome para a etapa.' });
  if (b.id) {
    db.prepare('UPDATE funnel_levels SET label = ?, ordem = COALESCE(?, ordem) WHERE id = ?')
      .run(label, b.ordem != null ? Number(b.ordem) : null, b.id);
    return res.json({ ok: true, id: Number(b.id) });
  }
  const prox = db.prepare('SELECT COALESCE(MAX(ordem),-1)+1 n FROM funnel_levels').get().n;
  const id = db.prepare('INSERT INTO funnel_levels (ordem, label, created_at) VALUES (?,?,?)')
    .run(b.ordem != null ? Number(b.ordem) : prox, label, now()).lastInsertRowid;
  res.json({ ok: true, id });
});

app.delete('/api/mapa/nivel/:id', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM funnel_nodes WHERE level_id = ?').run(req.params.id);
    db.prepare('DELETE FROM funnel_levels WHERE id = ?').run(req.params.id);
  })();
  res.json({ ok: true });
});

app.post('/api/mapa/no', (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Dê um nome para o caminho.' });
  const fonte = FONTES.some((f) => f.id === (b.fonte || '')) ? (b.fonte || '') : '';
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  // Número digitado só faz sentido quando não vem automático.
  const valor = fonte ? null : num(b.valor);
  if (b.id) {
    db.prepare('UPDATE funnel_nodes SET label=?, fonte=?, valor=?, meta=?, nota=? WHERE id=?')
      .run(label, fonte, valor, num(b.meta), String(b.nota || '').trim(), b.id);
    return res.json({ ok: true, id: Number(b.id) });
  }
  const lid = Number(b.level_id);
  if (!db.prepare('SELECT 1 FROM funnel_levels WHERE id = ?').get(lid)) {
    return res.status(400).json({ error: 'Etapa não encontrada.' });
  }
  const prox = db.prepare('SELECT COALESCE(MAX(ordem),-1)+1 n FROM funnel_nodes WHERE level_id = ?').get(lid).n;
  const id = db.prepare(`INSERT INTO funnel_nodes (level_id, ordem, label, fonte, valor, meta, nota, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(lid, prox, label, fonte, valor, num(b.meta), String(b.nota || '').trim(), now()).lastInsertRowid;
  res.json({ ok: true, id });
});

app.delete('/api/mapa/no/:id', (req, res) => {
  db.prepare('DELETE FROM funnel_nodes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// O funil em colunas, para arrastar a conversa até virar venda.
app.get('/api/pipeline', (req, res) => {
  const dias = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 60));
  const desde = dia(Date.now() - dias * 864e5);
  const cond = ['(a.stage IN ' + SQL_ABERTOS + ' OR a.day >= ?)']; const args = [desde];
  if (req.query.member_id) { cond.push('a.member_id = ?'); args.push(Number(req.query.member_id)); }
  const linhas = db.prepare(`SELECT a.*, t.name vendedor, s.code venda_code, s.total venda_total,
      c.name cliente_nome
    FROM atendimentos a
    LEFT JOIN team_members t ON t.id = a.member_id
    LEFT JOIN sales s ON s.id = a.sale_id
    LEFT JOIN customers c ON c.id = a.customer_id
    WHERE ${cond.join(' AND ')}
    ORDER BY COALESCE(a.updated_at, a.created_at) DESC LIMIT 500`).all(...args);

  const colunas = PIPE.map((p) => {
    const itens = linhas.filter((l) => l.stage === p.id);
    return { ...p, n: itens.length, valor: money(itens.reduce((s, i) => s + (i.valor || 0), 0)), itens };
  });
  const abertos = linhas.filter((l) => STAGES.indexOf(l.stage) < STAGES.indexOf('vendido'));
  res.json({
    dias, colunas,
    abertos: abertos.length,
    valor_aberto: money(abertos.reduce((s, i) => s + (i.valor || 0), 0)),
  });
});

// ==================== RELATÓRIOS DE LUCRO ====================
// A pergunta que interessa: o que dá dinheiro e onde ele está parado.
app.get('/api/relatorios', (req, res) => {
  const dias = Math.min(730, Math.max(7, parseInt(req.query.days, 10) || 90));
  const desde = new Date(Date.now() - dias * 864e5).toISOString();
  // Lucro por linha: o que entrou menos o custo que a peça tinha na hora
  // da venda (unit_cost fica gravado no item, então mudar o custo depois
  // não reescreve o passado).
  const base = `FROM sale_items i
    JOIN sales s ON s.id = i.sale_id
    LEFT JOIN variants v ON v.id = i.variant_id
    LEFT JOIN products p ON p.id = v.product_id
    WHERE s.payment_status <> 'cancelado' AND s.created_at >= ?`;

  const agrupado = (campo, rotulo) => db.prepare(`
    SELECT COALESCE(NULLIF(${campo},''),'(sem ${rotulo})') label,
      SUM(i.qty) pecas,
      ROUND(SUM(i.line_total),2) receita,
      ROUND(SUM(i.unit_cost * i.qty),2) custo,
      ROUND(SUM(i.line_total - i.unit_cost * i.qty),2) lucro
    ${base} GROUP BY label ORDER BY lucro DESC`).all(desde);

  const produtos = db.prepare(`
    SELECT COALESCE(v.product_id, 0) pid,
      MAX(COALESCE(p.name, i.name)) produto,
      MAX(p.brand) marca, MAX(p.category) categoria, MAX(p.image_url) imagem,
      SUM(i.qty) pecas,
      ROUND(SUM(i.line_total),2) receita,
      ROUND(SUM(i.unit_cost * i.qty),2) custo,
      ROUND(SUM(i.line_total - i.unit_cost * i.qty),2) lucro
    ${base} GROUP BY pid ORDER BY lucro DESC`).all(desde);

  const totais = produtos.reduce((t, p) => ({
    pecas: t.pecas + p.pecas, receita: money(t.receita + p.receita),
    custo: money(t.custo + p.custo), lucro: money(t.lucro + p.lucro),
  }), { pecas: 0, receita: 0, custo: 0, lucro: 0 });

  // Curva ABC: quem faz 80% do lucro é o A, 15% seguintes B, resto C.
  let acum = 0;
  const abc = produtos.map((p) => {
    acum += Math.max(0, p.lucro);
    const share = totais.lucro > 0 ? acum / totais.lucro : 0;
    return { ...p, classe: share <= 0.8 ? 'A' : (share <= 0.95 ? 'B' : 'C') };
  });
  const resumoAbc = ['A', 'B', 'C'].map((c) => {
    const g = abc.filter((p) => p.classe === c);
    return { classe: c, produtos: g.length, lucro: money(g.reduce((s, p) => s + p.lucro, 0)) };
  });

  // Dinheiro parado: tem estoque e não vende há tempo (ou nunca vendeu).
  const parado = db.prepare(`
    SELECT p.id, p.name produto, p.brand marca, p.category categoria, p.image_url imagem,
      COALESCE(p.on_demand,0) on_demand,
      SUM(CASE WHEN p.on_demand = 1 THEN COALESCE(v.on_hand,0) ELSE v.stock END) pecas,
      ROUND(SUM((CASE WHEN p.on_demand = 1 THEN COALESCE(v.on_hand,0) ELSE v.stock END) * v.cost),2) parado_custo,
      (SELECT MAX(s2.created_at) FROM sale_items i2
         JOIN sales s2 ON s2.id = i2.sale_id
         JOIN variants v2 ON v2.id = i2.variant_id
        WHERE v2.product_id = p.id AND s2.payment_status <> 'cancelado') ultima_venda
    FROM products p JOIN variants v ON v.product_id = p.id
    WHERE v.stock_management = 1
    GROUP BY p.id
    HAVING pecas > 0 AND (ultima_venda IS NULL OR ultima_venda < ?)
    ORDER BY parado_custo DESC LIMIT 40`).all(desde);
  const totalParado = money(parado.reduce((s, p) => s + (p.parado_custo || 0), 0));

  res.json({
    dias, desde,
    totais: { ...totais, margem_pct: totais.receita > 0 ? Math.round((totais.lucro / totais.receita) * 100) : 0 },
    produtos: abc.slice(0, 60),
    por_marca: agrupado('p.brand', 'marca'),
    por_categoria: agrupado('p.category', 'categoria'),
    abc: resumoAbc,
    parado, total_parado: totalParado,
  });
});

// ==================== UPLOAD DE FOTO ====================
// Recebe a imagem já redimensionada (base64) do navegador/celular e salva.
app.post('/api/upload', (req, res) => {
  const { data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'Nenhuma imagem recebida.' });
  const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(data);
  if (!m) return res.status(400).json({ error: 'Formato de imagem inválido.' });
  const ext = m[2].toLowerCase() === 'jpeg' ? 'jpg' : m[2].toLowerCase();
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: 'Imagem muito grande.' });
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  fs.writeFileSync(join(UPLOADS, name), buf);
  res.json({ ok: true, url: '/uploads/' + name });
});

// ==================== FINANCEIRO ====================
app.get('/api/financial', (req, res) => {
  const period = req.query.period || 'month';
  let since = null;
  const d = new Date();
  if (period === 'today') { d.setHours(0, 0, 0, 0); since = d.toISOString(); }
  else if (period === 'month') { since = new Date(d.getFullYear(), d.getMonth(), 1).toISOString(); }
  const cond = since ? 'AND created_at >= ?' : '';
  const a = since ? [since] : [];
  const receita = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM financial_entries WHERE type='receita' ${cond}`).get(...a).n;
  // Despesa que JÁ saiu do caixa x a que está só agendada. Somar as duas
  // no mesmo número faria o "sobrou" mostrar dinheiro que ainda está aí.
  const despesa = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM financial_entries
    WHERE type='despesa' AND paid = 1 ${cond}`).get(...a).n;
  const agendada = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM financial_entries
    WHERE type='despesa' AND paid = 0`).get().n;
  const aReceber = db.prepare("SELECT COALESCE(SUM(total),0) n FROM sales WHERE payment_status='pendente'").get().n;
  const byMethod = db.prepare(`SELECT COALESCE(NULLIF(payment_method,''),'—') label, COUNT(*) n, COALESCE(SUM(total),0) total
    FROM sales WHERE payment_status='pago' ${cond} GROUP BY payment_method ORDER BY total DESC`).all(...a);
  const entries = db.prepare(`SELECT id, type, category, description, amount, ref, paid, due_date, created_at
    FROM financial_entries ${since ? 'WHERE created_at >= ?' : ''} ORDER BY id DESC LIMIT 120`).all(...a);
  // Contas a pagar: o que está agendado, do mais vencido para o mais longe.
  const aPagar = db.prepare(`SELECT id, category, description, amount, due_date, created_at
    FROM financial_entries WHERE type='despesa' AND paid = 0
    ORDER BY COALESCE(due_date,'9999-12-31'), id`).all();
  const hoje = new Date().toISOString().slice(0, 10);
  const vencidas = aPagar.filter((e) => e.due_date && e.due_date < hoje);
  // Por categoria (o coração da gestão): entra e sai, agrupado.
  // Só o que já saiu/entrou de verdade — para bater com o número do topo.
  const porCategoria = (tipo) => db.prepare(`SELECT COALESCE(NULLIF(category,''),'Sem categoria') label,
      COUNT(*) n, COALESCE(SUM(amount),0) total FROM financial_entries
      WHERE type = ? AND paid = 1 ${cond} GROUP BY label ORDER BY total DESC`).all(tipo, ...a);
  // Receita por origem (PDV x Site) — as duas frentes.
  const porOrigem = db.prepare(`SELECT CASE WHEN channel='site' THEN 'Site' ELSE 'PDV' END origem,
      COUNT(*) n, COALESCE(SUM(total),0) total FROM sales
      WHERE payment_status='pago' ${cond} GROUP BY origem ORDER BY total DESC`).all(...a);
  // Lucro de verdade: o que sobrou depois do custo da mercadoria vendida.
  // A margem das vendas já desconta o custo; as demais despesas saem dela.
  const margemVendas = db.prepare(`SELECT COALESCE(SUM(margin),0) n FROM sales
    WHERE payment_status='pago' ${since ? 'AND created_at >= ?' : ''}`).get(...a).n;
  const despesaSemMercadoria = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM financial_entries
    WHERE type='despesa' AND paid = 1 AND category <> 'Compra de mercadoria' ${cond}`).get(...a).n;

  // Mês passado, para comparar.
  let anterior = null;
  if (period === 'month') {
    const ini = new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString();
    const fim = new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
    const r = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM financial_entries
      WHERE type='receita' AND created_at >= ? AND created_at < ?`).get(ini, fim).n;
    const de = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM financial_entries
      WHERE type='despesa' AND paid = 1 AND created_at >= ? AND created_at < ?`).get(ini, fim).n;
    const mg = db.prepare(`SELECT COALESCE(SUM(margin),0) n FROM sales
      WHERE payment_status='pago' AND created_at >= ? AND created_at < ?`).get(ini, fim).n;
    const dsm = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM financial_entries
      WHERE type='despesa' AND paid = 1 AND category <> 'Compra de mercadoria'
        AND created_at >= ? AND created_at < ?`).get(ini, fim).n;
    anterior = { receita: money(r), despesa: money(de), saldo: money(r - de), lucro: money(mg - dsm) };
  }

  res.json({
    period, receita: money(receita), despesa: money(despesa), saldo: money(receita - despesa),
    despesa_agendada: money(agendada), a_pagar: aPagar, a_pagar_vencidas: vencidas.length,
    lucro: money(margemVendas - despesaSemMercadoria),
    margem_vendas: money(margemVendas), despesas_operacao: money(despesaSemMercadoria),
    anterior,
    a_receber: money(aReceber), by_method: byMethod, entries,
    por_categoria_receita: porCategoria('receita'), por_categoria_despesa: porCategoria('despesa'),
    por_origem: porOrigem, ultima_importacao: getSetting('last_orders_import'),
  });
});

// Marcar uma despesa agendada como paga (aí sim sai do caixa).
app.post('/api/financial/entry/:id/pay', (req, res) => {
  const e = db.prepare('SELECT * FROM financial_entries WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Lançamento não encontrado.' });
  if (e.paid) return res.json({ ok: true, already: true });
  const ts = now();
  db.prepare('UPDATE financial_entries SET paid = 1, paid_at = ? WHERE id = ?').run(ts, e.id);
  // Se veio de uma entrada de mercadoria, a compra também fica quitada.
  if (e.ref) db.prepare('UPDATE purchases SET paid = 1 WHERE code = ?').run(e.ref);
  res.json({ ok: true, entry: db.prepare('SELECT * FROM financial_entries WHERE id = ?').get(e.id) });
});

// ==================== DESPESAS FIXAS ====================
// Aluguel, assinaturas, o que vence todo mês. O sistema lança sozinho.
app.get('/api/fixed-expenses', (req, res) => {
  const rows = db.prepare('SELECT * FROM fixed_expenses ORDER BY active DESC, day_of_month, name').all();
  const total = rows.filter((r) => r.active).reduce((s, r) => s + r.amount, 0);
  res.json({ total_mes: money(total), itens: rows });
});

app.post('/api/fixed-expenses', (req, res) => {
  const b = req.body || {};
  const nome = String(b.name || '').trim();
  const valor = money(b.amount);
  if (!nome) return res.status(400).json({ error: 'Dê um nome à despesa.' });
  if (!(valor > 0)) return res.status(400).json({ error: 'Informe um valor maior que zero.' });
  const dia = Math.min(28, Math.max(1, parseInt(b.day_of_month, 10) || 1));
  const cat = (b.category || 'Outras despesas').trim();
  if (b.id) {
    const cid = categoryId(cat, 'despesa');
    db.prepare(`UPDATE fixed_expenses SET name=?, category=?, category_id=?, amount=?, day_of_month=?, active=? WHERE id=?`)
      .run(nome, cat, cid, valor, dia, b.active === false ? 0 : 1, b.id);
    // Se a conta deste mês já foi lançada e ainda não foi paga, ela
    // acompanha a edição — senão você corrige o valor e a conta a pagar
    // continua mostrando o antigo.
    const ym = new Date().toISOString().slice(0, 7);
    const upd = db.prepare(`UPDATE financial_entries
      SET amount = ?, category = ?, category_id = ?, description = ?, due_date = ?
      WHERE ref = ? AND paid = 0`)
      .run(valor, cat, cid, `${nome} · ${ym}`, `${ym}-${String(dia).padStart(2, '0')}`, `FIXA-${b.id}-${ym}`);
    return res.json({ ok: true, atualizou_conta_do_mes: upd.changes > 0,
      item: db.prepare('SELECT * FROM fixed_expenses WHERE id = ?').get(b.id) });
  }
  const id = db.prepare(`INSERT INTO fixed_expenses (name, category, category_id, amount, day_of_month, created_at)
    VALUES (?,?,?,?,?,?)`).run(nome, cat, categoryId(cat, 'despesa'), valor, dia, now()).lastInsertRowid;
  res.json({ ok: true, item: db.prepare('SELECT * FROM fixed_expenses WHERE id = ?').get(id) });
});

app.delete('/api/fixed-expenses/:id', (req, res) => {
  db.prepare('DELETE FROM fixed_expenses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Lança as fixas que já chegaram no dia — uma vez por mês cada.
function lancarFixas() {
  const hoje = new Date();
  const ym = hoje.toISOString().slice(0, 7);
  const dia = hoje.getDate();
  const pend = db.prepare(`SELECT * FROM fixed_expenses
    WHERE active = 1 AND day_of_month <= ? AND COALESCE(last_ym,'') <> ?`).all(dia, ym);
  if (!pend.length) return 0;
  const ins = db.prepare(`INSERT INTO financial_entries (type, category, category_id, description, amount, ref, paid, due_date, paid_at, created_at)
    VALUES ('despesa',?,?,?,?,?,0,?,NULL,?)`);
  const marca = db.prepare('UPDATE fixed_expenses SET last_ym = ? WHERE id = ?');
  const ts = now();
  db.transaction(() => {
    for (const f of pend) {
      const venc = `${ym}-${String(f.day_of_month).padStart(2, '0')}`;
      // Entra como A PAGAR: quem decide que saiu do caixa é você.
      ins.run(f.category, f.category_id, `${f.name} · ${ym}`, f.amount, `FIXA-${f.id}-${ym}`, venc, ts);
      marca.run(ym, f.id);
    }
  })();
  return pend.length;
}

// ==================== FECHAMENTO DE CAIXA ====================
// Confere o que o sistema esperava receber com o que você contou.
app.get('/api/caixa', (req, res) => {
  const dia = (req.query.day || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const ini = `${dia}T00:00:00`, fim = `${dia}T23:59:59`;
  const porForma = db.prepare(`SELECT COALESCE(NULLIF(payment_method,''),'não informado') forma,
      COUNT(*) n, COALESCE(SUM(total),0) total FROM sales
    WHERE payment_status='pago' AND channel='pdv' AND created_at BETWEEN ? AND ?
    GROUP BY forma ORDER BY total DESC`).all(ini, fim);
  const site = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) total FROM sales
    WHERE payment_status='pago' AND channel='site' AND created_at BETWEEN ? AND ?`).get(ini, fim);
  const saidas = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM financial_entries
    WHERE type='despesa' AND paid = 1 AND created_at BETWEEN ? AND ?`).get(ini, fim).n;
  const especie = porForma.find((f) => /esp[ée]cie|dinheiro/i.test(f.forma));
  const fechado = db.prepare('SELECT * FROM cash_closings WHERE day = ?').get(dia);
  res.json({
    dia,
    por_forma: porForma,
    balcao: money(porForma.reduce((s, f) => s + f.total, 0)),
    site: { n: site.n, total: money(site.total) },
    saidas: money(saidas),
    esperado_especie: money(especie ? especie.total : 0),
    fechamento: fechado || null,
  });
});

app.post('/api/caixa/fechar', (req, res) => {
  const b = req.body || {};
  const dia = (b.day || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const contado = money(b.contado);
  if (!(contado >= 0)) return res.status(400).json({ error: 'Informe quanto você contou.' });
  const ini = `${dia}T00:00:00`, fim = `${dia}T23:59:59`;
  const porForma = db.prepare(`SELECT COALESCE(NULLIF(payment_method,''),'não informado') forma,
      COALESCE(SUM(total),0) total FROM sales
    WHERE payment_status='pago' AND channel='pdv' AND created_at BETWEEN ? AND ?
    GROUP BY forma`).all(ini, fim);
  const especie = porForma.find((f) => /esp[ée]cie|dinheiro/i.test(f.forma));
  const esperado = money(especie ? especie.total : 0);
  db.prepare(`INSERT INTO cash_closings (day, esperado, contado, diferenca, por_forma, note, created_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET esperado=excluded.esperado, contado=excluded.contado,
      diferenca=excluded.diferenca, por_forma=excluded.por_forma, note=excluded.note`)
    .run(dia, esperado, contado, money(contado - esperado), JSON.stringify(porForma), b.note || '', now());
  res.json({ ok: true, fechamento: db.prepare('SELECT * FROM cash_closings WHERE day = ?').get(dia) });
});

// Lançamento manual (despesa ou receita avulsa)
app.post('/api/financial/entry', (req, res) => {
  const b = req.body || {};
  const kind = b.type === 'receita' ? 'receita' : 'despesa';
  const amount = money(b.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Informe um valor maior que zero.' });
  const catName = (b.category || '').trim() || (kind === 'receita' ? 'Outras receitas' : 'Outras despesas');
  const cid = categoryId(catName, kind);
  const when = b.date ? new Date(b.date + 'T12:00:00').toISOString() : now();
  db.prepare(`INSERT INTO financial_entries (type, category, category_id, description, amount, created_at)
    VALUES (?,?,?,?,?,?)`).run(kind, catName, cid, (b.description || '').trim() || catName, amount, when);
  res.json({ ok: true });
});

app.delete('/api/financial/entry/:id', (req, res) => {
  db.prepare('DELETE FROM financial_entries WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Plano de contas ----
app.get('/api/fin-categories', (req, res) => {
  const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM financial_entries e WHERE e.category_id = c.id) AS uses
    FROM fin_categories c WHERE archived = 0 ORDER BY kind, name`).all();
  res.json({ receita: rows.filter((r) => r.kind === 'receita'), despesa: rows.filter((r) => r.kind === 'despesa') });
});
app.post('/api/fin-categories', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const kind = b.kind === 'receita' ? 'receita' : 'despesa';
  if (!name) return res.status(400).json({ error: 'Dê um nome à categoria.' });
  const id = categoryId(name, kind);
  res.json({ ok: true, category: db.prepare('SELECT * FROM fin_categories WHERE id = ?').get(id) });
});
app.delete('/api/fin-categories/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM fin_categories WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Categoria não encontrada.' });
  if (c.is_system) return res.status(400).json({ error: 'Categoria padrão não pode ser removida.' });
  db.prepare('UPDATE fin_categories SET archived = 1 WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// ==================== VENDAS DO SITE (Nuvemshop) ====================
// Lê os pedidos da loja e lança a receita. NÃO mexe no estoque: quem
// vende no site é a Nuvemshop, e ela já baixa o estoque dela — o nosso
// acerta na sincronização de produtos (que traz o valor atual dela).
// Nomes que a loja usa quando o comprador não se identificou. Nunca
// servem para casar pessoas — senão vira tudo um cliente só.
const NOME_GENERICO = /^(\s*|-+|n[ãa]o\s+informad[oa]|sem\s+nome|cliente(\s+do\s+site)?|consumidor(\s+final)?|visitante|guest|n\/?a)\s*$/i;
const nomeUtil = (n) => Boolean(n) && !NOME_GENERICO.test(String(n).trim());

// Traz os clientes da loja para cá (cadastro), sem duplicar.
async function importarClientes() {
  const lista = await nuvem.listAllCustomers();
  const porNs = db.prepare('SELECT id FROM customers WHERE nuvemshop_customer_id = ?');
  const porEmail = db.prepare("SELECT id FROM customers WHERE email <> '' AND lower(email) = lower(?)");
  const porNome = db.prepare('SELECT id FROM customers WHERE lower(name) = lower(?) AND nuvemshop_customer_id IS NULL');
  const ins = db.prepare(`INSERT INTO customers (nuvemshop_customer_id, name, instagram, phone, email, created_at) VALUES (?,?,?,?,?,?)`);
  const upd = db.prepare(`UPDATE customers SET nuvemshop_customer_id=?, phone=COALESCE(NULLIF(phone,''),?),
    email=COALESCE(NULLIF(email,''),?), instagram=COALESCE(NULLIF(instagram,''),?) WHERE id=?`);

  let novos = 0, vinculados = 0;
  db.transaction(() => {
    for (const c of lista) {
      const nsId = String(c.id);
      const nome = (c.name || c.email || 'Cliente').trim();
      const email = (c.email || '').trim();
      const fone = (c.phone || (c.default_address && c.default_address.phone) || '').trim();
      // Muita gente se cadastra com o próprio @ no nome — vira o Instagram.
      const insta = nome.startsWith('@') ? limpaInsta(nome) : '';
      if (porNs.get(nsId)) continue;
      // Já existe aqui (cadastrado no PDV)? Então só liga os dois.
      // O nome só serve para casar se identificar mesmo a pessoa.
      const existente = (email && porEmail.get(email)) || (nomeUtil(nome) ? porNome.get(nome) : null);
      if (existente) { upd.run(nsId, fone, email, insta, existente.id); vinculados += 1; continue; }
      ins.run(nsId, nome, insta, fone, email, c.created_at ? new Date(c.created_at).toISOString() : now());
      novos += 1;
    }
  })();
  return { total: lista.length, novos, vinculados };
}

// Liga os pedidos do site já importados ao cliente correspondente,
// para o ranking mostrar o histórico real de cada pessoa.
function vincularPedidos() {
  const porNs = db.prepare('SELECT id FROM customers WHERE nuvemshop_customer_id = ?');
  const porNome = db.prepare('SELECT id FROM customers WHERE lower(name) = lower(?) LIMIT 1');
  const pend = db.prepare(`SELECT id, ns_customer_id, customer_name FROM sales
    WHERE channel='site' AND customer_id IS NULL`).all();
  const upd = db.prepare('UPDATE sales SET customer_id = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    for (const s of pend) {
      // Sem identificador da loja, o nome só vale se identificar alguém.
      let c = s.ns_customer_id ? porNs.get(String(s.ns_customer_id)) : null;
      if (!c && nomeUtil(s.customer_name)) c = porNome.get(s.customer_name.trim());
      if (c) { upd.run(c.id, s.id); n += 1; }
    }
  })();
  return n;
}

// Desfaz o agrupamento errado: pedidos de visitantes que tinham sido
// juntados sob um cliente genérico voltam a ficar sem dono, e o cadastro
// genérico é removido se não sobrar nada nele.
function limparClientesGenericos() {
  // Vale para qualquer cadastro sem nome de gente — inclusive os que
  // vieram com identificador da loja.
  const suspeitos = db.prepare('SELECT id, name, nuvemshop_customer_id FROM customers').all()
    .filter((c) => !nomeUtil(c.name));
  let soltos = 0, apagados = 0;
  db.transaction(() => {
    for (const c of suspeitos) {
      const r = db.prepare("UPDATE sales SET customer_id = NULL WHERE customer_id = ? AND channel = 'site'").run(c.id);
      soltos += r.changes;
      const aindaTem = db.prepare('SELECT 1 FROM sales WHERE customer_id = ? LIMIT 1').get(c.id);
      const emLembrete = db.prepare('SELECT 1 FROM reminders WHERE customer_id = ? LIMIT 1').get(c.id);
      if (!aindaTem && !emLembrete) { db.prepare('DELETE FROM customers WHERE id = ?').run(c.id); apagados += 1; }
    }
  })();
  return { soltos, apagados };
}

// Sincroniza os pedidos do site: cria os novos e ATUALIZA os que mudaram
// de status (pagou, embalou, enviou). Roda sozinho de tempos em tempos.
async function sincronizarPedidos(dias = 45) {
  if (!isLive()) return { skipped: true };
  const desde = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
  const orders = await nuvem.listOrders({ since: desde });

  const achar = db.prepare('SELECT id, payment_status, fin_posted FROM sales WHERE nuvemshop_order_id = ?');
  const insSale = db.prepare(`INSERT INTO sales (code, channel, nuvemshop_order_id, customer_id, ns_customer_id, customer_name, payment_method,
      payment_status, paid_at, subtotal, discount, total, cost_total, margin, synced_nuvemshop, created_at,
      ns_payment_status, ns_shipping_status, ns_status, ns_shipping_type, items_count, fin_posted)
    VALUES (?, 'site', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?)`);
  const acharCliente = db.prepare('SELECT id FROM customers WHERE nuvemshop_customer_id = ?');
  const acharPorNome = db.prepare('SELECT id FROM customers WHERE lower(name) = lower(?) LIMIT 1');
  const criarCliente = db.prepare('INSERT INTO customers (nuvemshop_customer_id, name, instagram, phone, email, created_at) VALUES (?,?,?,?,?,?)');
  const updSale = db.prepare(`UPDATE sales SET payment_status=?, paid_at=COALESCE(paid_at,?), total=?, subtotal=?, margin=?,
      ns_payment_status=?, ns_shipping_status=?, ns_status=?, ns_shipping_type=?, items_count=?, payment_method=?
    WHERE id=?`);
  const marcarFin = db.prepare('UPDATE sales SET fin_posted = 1 WHERE id = ?');
  const insFin = db.prepare(`INSERT INTO financial_entries (type, category, category_id, description, amount, ref, created_at)
    VALUES ('receita','Venda Site',?,?,?,?,?)`);
  const catSite = categoryId('Venda Site', 'receita');

  let novos = 0, atualizados = 0, lancados = 0;
  db.transaction(() => {
    for (const o of orders) {
      const oid = String(o.id);
      const nsPay = String(o.payment_status || '').toLowerCase();       // pending | paid | ...
      const nsShip = String(o.shipping_status || o.fulfillment_status || '').toLowerCase();
      const nsStat = String(o.status || '').toLowerCase();              // open | closed | cancelled
      const cancelado = nsStat === 'cancelled' || Boolean(o.cancelled_at);
      const pago = nsPay === 'paid';
      const retirada = Boolean(o.shipping_pickup_details)
        || /pickup|retir/i.test(String(o.shipping_option || o.shipping || ''));
      const total = money(parseFloat(o.total) || 0);
      const quando = o.created_at ? new Date(o.created_at).toISOString() : now();
      const cliente = (o.customer && (o.customer.name || o.customer.email)) || 'Cliente do site';
      const forma = (o.payment_details && o.payment_details.method) || o.gateway_name || o.gateway || 'Site';
      const nItens = Array.isArray(o.products) ? o.products.reduce((s, p) => s + (parseInt(p.quantity, 10) || 0), 0) : 0;
      const code = 'SITE-' + (o.number || oid);
      const nosso = cancelado ? 'cancelado' : (pago ? 'pago' : 'pendente');

      // Cliente do pedido. O identificador da loja é o que vale: só ele
      // diz que dois pedidos são da MESMA pessoa. Compra de visitante
      // (sem identificação) fica sem cliente, em vez de virar um
      // "não informado" que engoliria o ranking.
      const nsCli = o.customer && o.customer.id ? String(o.customer.id) : null;
      let cliId = null;
      if (nsCli) {
        const c = acharCliente.get(nsCli);
        if (c) cliId = c.id;
        else {
          // Pode ser alguém já cadastrado aqui pelo PDV: casa por nome
          // apenas quando o nome identifica de verdade.
          const local = nomeUtil(cliente) ? acharPorNome.get(cliente) : null;
          if (local) { db.prepare('UPDATE customers SET nuvemshop_customer_id = ? WHERE id = ?').run(nsCli, local.id); cliId = local.id; }
          else cliId = criarCliente.run(nsCli, nomeUtil(cliente) ? cliente : 'Cliente do site',
            String(cliente || '').trim().startsWith('@') ? limpaInsta(cliente) : '',
            (o.customer.phone || ''), (o.customer.email || ''), quando).lastInsertRowid;
        }
      }

      const ex = achar.get(oid);
      if (!ex) {
        const id = insSale.run(code, oid, cliId, nsCli, cliente, forma, nosso, pago ? quando : null, total, total, total, quando,
          nsPay, nsShip, nsStat, retirada ? 'retirada' : 'envio', nItens, 0).lastInsertRowid;
        novos += 1;
        if (pago && !cancelado) { insFin.run(catSite, `Venda no site ${code}`, total, code, quando); marcarFin.run(id); lancados += 1; }
      } else {
        updSale.run(nosso, pago ? quando : null, total, total, total,
          nsPay, nsShip, nsStat, retirada ? 'retirada' : 'envio', nItens, forma, ex.id);
        // Corrige o vínculo (não usa COALESCE: se estava errado, conserta).
        db.prepare('UPDATE sales SET customer_id = ?, ns_customer_id = ? WHERE id = ?').run(cliId, nsCli, ex.id);
        atualizados += 1;
        // Pagou depois? Agora entra no caixa (uma única vez).
        if (pago && !cancelado && !ex.fin_posted) {
          insFin.run(catSite, `Venda no site ${code}`, total, code, now());
          marcarFin.run(ex.id); lancados += 1;
        }
      }
    }
  })();
  setSetting('last_orders_import', now());
  return { novos, atualizados, lancados, analisados: orders.length, desde };
}

// Motor automático: verifica a loja de tempos em tempos, sozinho.
const INTERVALO_MIN = Math.max(2, parseInt(process.env.SYNC_MINUTES, 10) || 10);
let sincronizando = false;
async function tickAutomatico(motivo = 'automático') {
  // As fixas não dependem da loja: rodam mesmo sem conexão.
  try { const n = lancarFixas(); if (n) console.log(`› ${n} despesa(s) fixa(s) lançada(s) como a pagar.`); }
  catch (err) { console.error('Despesas fixas:', err.message); }

  if (sincronizando || !isLive()) return;
  sincronizando = true;
  try {
    const r = await sincronizarPedidos();
    if (r && !r.skipped && (r.novos || r.lancados)) {
      console.log(`› Pedidos do site (${motivo}): ${r.novos} novo(s), ${r.lancados} lançado(s) no caixa.`);
    }
    const c = await sincronizarCarrinhos();
    if (c && c.novos) console.log(`› Carrinhos abandonados: ${c.novos} novo(s).`);
    const msgs = gerarMensagens();
    if (msgs) console.log(`› ${msgs} mensagem(ns) esperando envio.`);
  } catch (err) {
    console.error('Sincronização de pedidos falhou:', err.message);
    setSetting('last_orders_error', err.message);
  } finally { sincronizando = false; }
}
setInterval(() => tickAutomatico(), INTERVALO_MIN * 60 * 1000);
setTimeout(() => tickAutomatico('início'), 8000);

// Traz clientes + histórico de vendas da loja e monta o ranking real.
// Pode demorar em lojas com muitos pedidos — por isso o retorno é um
// resumo do que entrou.
app.post('/api/import-customers', async (req, res) => {
  if (!isLive()) return res.status(400).json({ error: 'Conecte a loja primeiro.' });
  const b = req.body || {};
  const dias = parseInt(b.days, 10) || 730; // 2 anos por padrão
  try {
    const cli = await importarClientes();
    const ped = await sincronizarPedidos(dias);
    const ligados = vincularPedidos();
    const limpeza = limparClientesGenericos();
    const insta = detectarInstagram();
    const rank = db.prepare(`SELECT COUNT(*) n FROM (
      SELECT customer_id FROM sales WHERE customer_id IS NOT NULL GROUP BY customer_id)`).get().n;
    res.json({
      ok: true,
      clientes: cli,
      pedidos: { novos: ped.novos || 0, atualizados: ped.atualizados || 0, analisados: ped.analisados || 0, desde: ped.desde },
      pedidos_vinculados: ligados,
      corrigidos: limpeza,
      instagram: insta,
      clientes_com_historico: rank,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});


// ==================== VISÃO OPERACIONAL ====================
// O que precisa de ação agora, juntando site e balcão, e os números
// do período (hoje / ontem / esta semana).
app.get('/api/operacao', (req, res) => {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const ontem = new Date(hoje); ontem.setDate(ontem.getDate() - 1);
  const semana = new Date(hoje); semana.setDate(semana.getDate() - hoje.getDay()); // domingo

  const metricas = (de, ate) => {
    const args = ate ? [de.toISOString(), ate.toISOString()] : [de.toISOString()];
    const cond = ate ? 'created_at >= ? AND created_at < ?' : 'created_at >= ?';
    const t = db.prepare(`SELECT COUNT(*) pedidos, COALESCE(SUM(total),0) fat, COALESCE(SUM(margin),0) marg,
        COALESCE(SUM(items_count),0) pecas FROM sales
        WHERE payment_status='pago' AND ${cond}`).get(...args);
    const porCanal = db.prepare(`SELECT CASE WHEN channel='site' THEN 'site' ELSE 'pdv' END c,
        COUNT(*) n, COALESCE(SUM(total),0) t FROM sales
        WHERE payment_status='pago' AND ${cond} GROUP BY c`).all(...args);
    const pdv = porCanal.find((x) => x.c === 'pdv') || { n: 0, t: 0 };
    const site = porCanal.find((x) => x.c === 'site') || { n: 0, t: 0 };
    return {
      pedidos: t.pedidos, faturamento: money(t.fat), ticket: t.pedidos ? money(t.fat / t.pedidos) : 0,
      margem_pct: t.fat > 0 ? Math.round((t.marg / t.fat) * 100) : 0,
      pdv: { n: pdv.n, total: money(pdv.t) }, site: { n: site.n, total: money(site.t) },
    };
  };

  // Filas de trabalho. "Por cobrar" junta o fiado do balcão com o
  // pedido do site que ainda não foi pago.
  const fila = (sql, ...a) => db.prepare(sql).get(...a);
  const naoEnviado = `(COALESCE(ns_shipping_status,'') NOT IN ('shipped','fulfilled','delivered'))`;
  const ativo = `COALESCE(ns_status,'open') <> 'cancelled' AND payment_status <> 'cancelado'`;

  const porCobrar = fila(`SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM sales
    WHERE payment_status='pendente' AND ${ativo}`);
  const porEmbalar = fila(`SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM sales
    WHERE channel='site' AND payment_status='pago' AND ${ativo} AND COALESCE(ns_shipping_type,'envio')='envio'
      AND COALESCE(ns_shipping_status,'') IN ('','unpacked','unfulfilled')`);
  const porEnviar = fila(`SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM sales
    WHERE channel='site' AND payment_status='pago' AND ${ativo} AND COALESCE(ns_shipping_type,'envio')='envio'
      AND COALESCE(ns_shipping_status,'') IN ('packed','ready','unshipped')`);
  const porRetirar = fila(`SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM sales
    WHERE channel='site' AND payment_status='pago' AND ${ativo} AND ns_shipping_type='retirada' AND ${naoEnviado}`);

  const listar = (where, args = []) => db.prepare(`SELECT id, code, channel, customer_name, total, created_at,
      payment_status, ns_shipping_status, ns_shipping_type FROM sales WHERE ${where}
      ORDER BY created_at DESC LIMIT 40`).all(...args);

  res.json({
    filas: {
      por_cobrar: { ...porCobrar, t: money(porCobrar.t) },
      por_embalar: { ...porEmbalar, t: money(porEmbalar.t) },
      por_enviar: { ...porEnviar, t: money(porEnviar.t) },
      por_retirar: { ...porRetirar, t: money(porRetirar.t) },
    },
    periodos: {
      hoje: metricas(hoje),
      ontem: metricas(ontem, hoje),
      semana: metricas(semana),
    },
    conectado: isLive(),
    ultima_leitura: getSetting('last_orders_import'),
    intervalo_min: INTERVALO_MIN,
  });
});

// Lista de uma fila específica (ao clicar no card)
app.get('/api/operacao/:fila', (req, res) => {
  const ativo = `COALESCE(ns_status,'open') <> 'cancelled' AND payment_status <> 'cancelado'`;
  const mapa = {
    por_cobrar: `payment_status='pendente' AND ${ativo}`,
    por_embalar: `channel='site' AND payment_status='pago' AND ${ativo} AND COALESCE(ns_shipping_type,'envio')='envio' AND COALESCE(ns_shipping_status,'') IN ('','unpacked','unfulfilled')`,
    por_enviar: `channel='site' AND payment_status='pago' AND ${ativo} AND COALESCE(ns_shipping_type,'envio')='envio' AND COALESCE(ns_shipping_status,'') IN ('packed','ready','unshipped')`,
    por_retirar: `channel='site' AND payment_status='pago' AND ${ativo} AND ns_shipping_type='retirada' AND COALESCE(ns_shipping_status,'') NOT IN ('shipped','fulfilled','delivered')`,
  };
  const where = mapa[req.params.fila];
  if (!where) return res.status(404).json({ error: 'Fila desconhecida.' });
  res.json(db.prepare(`SELECT id, code, channel, customer_name, total, created_at, payment_status,
    ns_shipping_type, items_count FROM sales WHERE ${where} ORDER BY created_at DESC LIMIT 60`).all());
});

// ==================== LEMBRETES ====================
app.get('/api/reminders', (req, res) => {
  const filtro = req.query.filter || 'abertos';
  const hoje = new Date().toISOString().slice(0, 10);
  let where = 'r.done = 0';
  if (filtro === 'feitos') where = 'r.done = 1';
  else if (filtro === 'todos') where = '1=1';
  const rows = db.prepare(`SELECT r.*, c.name AS customer_name FROM reminders r
    LEFT JOIN customers c ON c.id = r.customer_id
    WHERE ${where} ORDER BY r.done, COALESCE(r.due_date,'9999-12-31'), r.id DESC LIMIT 200`).all();
  const marcado = rows.map((r) => ({
    ...r,
    atrasado: !r.done && r.due_date && r.due_date < hoje,
    hoje: !r.done && r.due_date === hoje,
  }));
  const resumo = db.prepare(`SELECT
      SUM(CASE WHEN done=0 AND due_date < ? THEN 1 ELSE 0 END) AS atrasados,
      SUM(CASE WHEN done=0 AND due_date = ? THEN 1 ELSE 0 END) AS hoje,
      SUM(CASE WHEN done=0 THEN 1 ELSE 0 END) AS abertos
    FROM reminders`).get(hoje, hoje);
  res.json({ items: marcado, resumo });
});
app.post('/api/reminders', (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Escreva o que precisa ser lembrado.' });
  const id = db.prepare(`INSERT INTO reminders (title, notes, due_date, kind, customer_id, amount, created_at)
    VALUES (?,?,?,?,?,?,?)`).run(title, (b.notes || '').trim(), b.due_date || null,
    b.kind || 'geral', b.customer_id || null, b.amount ? money(b.amount) : null, now()).lastInsertRowid;
  res.json({ ok: true, id });
});
app.put('/api/reminders/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Lembrete não encontrado.' });
  const b = req.body || {};
  if (b.done !== undefined) {
    db.prepare('UPDATE reminders SET done = ?, done_at = ? WHERE id = ?').run(b.done ? 1 : 0, b.done ? now() : null, r.id);
  } else {
    db.prepare('UPDATE reminders SET title=?, notes=?, due_date=?, kind=?, customer_id=?, amount=? WHERE id=?')
      .run(b.title ?? r.title, b.notes ?? r.notes, b.due_date ?? r.due_date, b.kind ?? r.kind,
        b.customer_id ?? r.customer_id, b.amount !== undefined ? money(b.amount) : r.amount, r.id);
  }
  res.json({ ok: true });
});
app.delete('/api/reminders/:id', (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== CONEXÃO NUVEMSHOP ====================
app.get('/api/connection', (req, res) => res.json(nuvem.connectionInfo()));

// Salva App ID + Secret (informados na tela Conectar). NÃO conecta ainda.
app.post('/api/connect/app', (req, res) => {
  const b = req.body || {};
  const id = String(b.client_id || '').trim();
  const secret = String(b.client_secret || '').trim();
  if (!id || !secret) return res.status(400).json({ error: 'Informe o App ID e o Secret.' });
  setSetting('nuvemshop_client_id', id);
  setSetting('nuvemshop_client_secret', secret);
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ ok: true, callback_url: `${base}/oauth/callback`, authorize_url: `https://www.nuvemshop.com.br/apps/${id}/authorize` });
});

// Callback do OAuth: recebe o "code", troca pelo token e salva. Só LEITURA.
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/conectar?erro=' + encodeURIComponent('Autorização não retornou o código.'));
  try {
    const data = await nuvem.exchangeCodeForToken(code);
    if (!data || !data.access_token || !data.user_id) throw new Error('A Nuvemshop não retornou o token esperado.');
    setSetting('nuvemshop_access_token', data.access_token);
    setSetting('nuvemshop_store_id', String(data.user_id));
    res.redirect('/conectar?ok=1');
  } catch (err) {
    res.redirect('/conectar?erro=' + encodeURIComponent(err.message));
  }
});

// Desconectar: limpa as credenciais localmente. NÃO altera nada na Nuvemshop.
app.post('/api/disconnect', (req, res) => {
  setSetting('nuvemshop_access_token', '');
  setSetting('nuvemshop_store_id', '');
  res.json({ ok: true });
});

// Páginas
const page = (f) => (req, res) => res.sendFile(join(__dirname, '..', 'public', f));
app.get('/login', page('login.html'));
app.get('/conectar', page('conectar.html'));
app.get('/pdv', page('pdv.html'));
app.get('/clientes', page('clientes.html'));
// Atalhos antigos continuam valendo — a tela de clientes absorveu os dois.
app.get('/crm', page('clientes.html'));
app.get('/funil', page('clientes.html'));
app.get('/produtos', page('produtos.html'));
app.get('/estoque', page('produtos.html'));
app.get('/financeiro', page('financeiro.html'));
app.get('/negocio', page('negocio.html'));
app.get('/agentes', page('agentes.html'));
app.get('/lembretes', page('index.html'));   // virou o painel do Início
app.get('/compras', page('produtos.html'));   // virou a aba Entradas
app.get('/custos', page('custos.html'));
app.get('/relatorios', page('financeiro.html'));   // virou a aba Lucro
app.get('/equipe', page('equipe.html'));
app.get('/ajuda', page('ajuda.html'));
app.get('/como-usar', page('ajuda.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🐊 VN Store — Sistema no ar na porta ${PORT}`);
  console.log(`     Modo: ${isLive() ? 'AO VIVO (Nuvemshop conectada)' : 'DEMONSTRAÇÃO (sem token)'}`);
  console.log(`     Login: ${APP_PASSWORD ? 'com senha (APP_PASSWORD)' : 'aberto (sem senha)'}\n`);
});

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
  const base = `SELECT v.*, p.brand, p.category, p.image_url FROM variants v LEFT JOIN products p ON p.id = v.product_id`;
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
  const rows = db.prepare(`
    SELECT p.*,
      COUNT(v.id) AS variant_count,
      COALESCE(SUM(v.stock),0) AS total_stock,
      COALESCE(SUM(v.stock * v.cost),0) AS stock_value_cost,
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
    SELECT COALESCE(SUM(v.stock),0) AS units,
           COALESCE(SUM(v.stock * v.cost),0) AS value_cost,
           COALESCE(SUM(v.stock * v.price),0) AS value_price
    FROM variants v WHERE v.stock_management = 1
  `).get();
  const byCategory = db.prepare(`
    SELECT COALESCE(NULLIF(p.category,''),'(sem categoria)') AS label,
           COUNT(DISTINCT p.id) AS products,
           COALESCE(SUM(v.stock),0) AS units,
           COALESCE(SUM(v.stock * v.cost),0) AS value_cost
    FROM products p LEFT JOIN variants v ON v.product_id = p.id
    GROUP BY label ORDER BY units DESC
  `).all();
  const byBrand = db.prepare(`
    SELECT COALESCE(NULLIF(p.brand,''),'(sem marca)') AS label,
           COUNT(DISTINCT p.id) AS products,
           COALESCE(SUM(v.stock),0) AS units,
           COALESCE(SUM(v.stock * v.cost),0) AS value_cost
    FROM products p LEFT JOIN variants v ON v.product_id = p.id
    GROUP BY label ORDER BY units DESC
  `).all();
  res.json({ totals, by_category: byCategory, by_brand: byBrand });
});

app.get('/api/catalog/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado.' });
  p.variants = db.prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY id').all(p.id);
  res.json(p);
});

// Cria produto (mestre + variações) no nosso sistema e empurra p/ Nuvemshop.
app.post('/api/catalog', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Dê um nome ao produto.' });
  const variants = Array.isArray(b.variants) && b.variants.length ? b.variants : [{ variant_name: 'Único', sku: '', price: b.price || 0, cost: b.cost || 0, stock: b.stock || 0 }];
  const ts = now();
  const productId = db.transaction(() => {
    const pid = db.prepare(`INSERT INTO products (name, brand, category, description, image_url, weight, published, synced_nuvemshop, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,0,?,?)`).run(String(b.name).trim(), b.brand || '', b.category || '', b.description || '',
        b.image_url || '', b.weight ? Number(b.weight) : null, b.published === false ? 0 : 1, ts, ts).lastInsertRowid;
    const insV = db.prepare(`INSERT INTO variants (product_id, product_name, variant_name, sku, price, cost, stock, stock_management, updated_at)
      VALUES (?,?,?,?,?,?,?,1,?)`);
    for (const v of variants) {
      insV.run(pid, String(b.name).trim(), v.variant_name || 'Único', v.sku || '', money(v.price), money(v.cost), parseInt(v.stock, 10) || 0, ts);
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
    db.prepare(`UPDATE products SET name=?, brand=?, category=?, description=?, image_url=?, weight=?, published=?, updated_at=? WHERE id=?`)
      .run(b.name ?? p.name, b.brand ?? p.brand, b.category ?? p.category, b.description ?? p.description,
        b.image_url ?? p.image_url, b.weight !== undefined ? (b.weight ? Number(b.weight) : null) : p.weight,
        b.published === false ? 0 : 1, ts, p.id);
    if (Array.isArray(b.variants)) {
      // A lista recebida é a lista COMPLETA de variações do produto.
      const upd = db.prepare('UPDATE variants SET variant_name=?, sku=?, price=?, cost=?, stock=?, product_name=?, updated_at=? WHERE id=? AND product_id=?');
      const insV = db.prepare(`INSERT INTO variants (product_id, product_name, variant_name, sku, price, cost, stock, stock_management, updated_at) VALUES (?,?,?,?,?,?,?,1,?)`);
      const mantidos = new Set();
      for (const v of b.variants) {
        if (v.id) {
          upd.run(v.variant_name || 'Único', v.sku || '', money(v.price), money(v.cost), parseInt(v.stock, 10) || 0, b.name ?? p.name, ts, v.id, p.id);
          mantidos.add(Number(v.id));
        } else {
          const novo = insV.run(p.id, b.name ?? p.name, v.variant_name || 'Único', v.sku || '', money(v.price), money(v.cost), parseInt(v.stock, 10) || 0, ts);
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
    const id = db.prepare(`INSERT INTO products (name, brand, category, categories_all, description,
        image_url, weight, published, synced_nuvemshop, created_at, updated_at)
      VALUES (?,?,?,?,?, '', ?, 1, 0, ?, ?)`)
      .run(`${p.name} (cópia)`, p.brand, p.category, p.categories_all, p.description, p.weight, ts, ts).lastInsertRowid;
    const ins = db.prepare(`INSERT INTO variants (product_id, product_name, variant_name, sku, price, cost, stock, stock_management, updated_at)
      VALUES (?,?,?,'',?,?,0,1,?)`);   // sem SKU e com estoque zerado: você preenche o que chegou
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

// Diagnóstico: mostra como a SUA loja organiza os produtos de verdade
// (campos preenchidos, categorias, tags) para alinhar o sistema ao real.
app.get('/api/debug/estrutura', async (req, res) => {
  if (!isLive()) return res.status(400).json({ error: 'Conecte a loja primeiro.' });
  try {
    const sample = await nuvem.listAllProducts({ publishedOnly: true, maxPages: 1 });
    const cats = await nuvem.listAllCategories();

    // O que está de fato preenchido nos produtos?
    let comBrand = 0, comTags = 0, comCategorias = 0;
    const tagsVistas = new Set();
    for (const p of sample) {
      const brand = typeof p.brand === 'string' ? p.brand.trim() : '';
      if (brand) comBrand += 1;
      const tags = typeof p.tags === 'string' ? p.tags.split(',').map((t) => t.trim()).filter(Boolean) : (Array.isArray(p.tags) ? p.tags : []);
      if (tags.length) { comTags += 1; tags.forEach((t) => tagsVistas.add(t)); }
      if ((p.categories || []).length) comCategorias += 1;
    }

    // Árvore de categorias (pai → filhas), que é como o site costuma
    // organizar "Marcas" e "Categorias".
    const byId = new Map(cats.map((c) => [c.id, c]));
    const arvore = cats.map((c) => ({
      id: c.id,
      nome: nameOf(c.name),
      pai: c.parent ? (byId.get(c.parent) ? nameOf(byId.get(c.parent).name) : c.parent) : null,
    }));
    const raizes = arvore.filter((c) => !c.pai).map((r) => ({
      nome: r.nome,
      filhas: arvore.filter((c) => c.pai === r.nome).map((c) => c.nome),
    }));

    res.json({
      analisados: sample.length,
      campos_preenchidos: { brand: comBrand, tags: comTags, categorias: comCategorias },
      total_categorias: cats.length,
      arvore_categorias: raizes,
      tags_encontradas: [...tagsVistas].slice(0, 40),
      exemplos: sample.slice(0, 3).map((p) => ({
        nome: nameOf(p.name),
        brand: p.brand ?? null,
        tags: p.tags ?? null,
        categorias: (p.categories || []).map((c) => nameOf(c.name)),
        variacoes: (p.variants || []).slice(0, 3).map((v) => ({
          valores: (v.values || []).map((x) => nameOf(x)), preco: v.price, estoque: v.stock,
        })),
      })),
    });
  } catch (err) {
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

// ==================== CLIENTES ====================
// Ranking: quanto cada cliente já gastou + pendências.
app.get('/api/customers', (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  // "Gastou" = o que a pessoa efetivamente pagou. Pedido cancelado não
  // conta, e o que está em aberto aparece à parte, em "a receber".
  const rows = db.prepare(`
    SELECT c.*,
      COUNT(CASE WHEN s.payment_status <> 'cancelado' THEN s.id END) AS orders,
      COALESCE(SUM(CASE WHEN s.payment_status='pago' THEN s.total ELSE 0 END),0) AS total_spent,
      COALESCE(SUM(CASE WHEN s.payment_status='pendente' THEN s.total ELSE 0 END),0) AS pending,
      MAX(CASE WHEN s.payment_status <> 'cancelado' THEN s.created_at END) AS last_purchase,
      CASE WHEN c.nuvemshop_customer_id IS NOT NULL THEN 1 ELSE 0 END AS da_loja
    FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
    ${q ? 'WHERE c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?' : ''}
    GROUP BY c.id ORDER BY total_spent DESC, c.name
  `).all(...(q ? [like, like, like] : []));
  res.json(rows);
});

app.get('/api/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente não encontrado.' });
  c.sales = db.prepare('SELECT id, code, total, payment_method, payment_status, created_at FROM sales WHERE customer_id = ? ORDER BY id DESC').all(c.id);
  const agg = db.prepare(`SELECT
    COUNT(CASE WHEN payment_status <> 'cancelado' THEN 1 END) AS orders,
    COALESCE(SUM(CASE WHEN payment_status='pago' THEN total ELSE 0 END),0) AS total_spent,
    COALESCE(SUM(CASE WHEN payment_status='pendente' THEN total ELSE 0 END),0) AS pending
    FROM sales WHERE customer_id = ?`).get(c.id);
  res.json({ ...c, ...agg });
});

app.post('/api/customers', async (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Informe o nome do cliente.' });
  const id = db.prepare('INSERT INTO customers (name, phone, email, note, created_at) VALUES (?,?,?,?,?)')
    .run(String(b.name).trim(), b.phone || '', b.email || '', b.note || '', now()).lastInsertRowid;
  res.json({ ok: true, customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(id) });
});

// ==================== VENDA (PDV) ====================
app.post('/api/sales', async (req, res) => {
  const { items = [], customer_id = null, new_customer = null, customer_name = '', payment_method = '', payment_status = 'pago', discount = 0 } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Adicione ao menos um item à venda.' });

  // Cliente: usa existente, cria novo, ou anônimo.
  let custId = customer_id || null;
  let custName = customer_name || '';
  if (!custId && new_customer && new_customer.name) {
    custId = db.prepare('INSERT INTO customers (name, phone, created_at) VALUES (?,?,?)').run(new_customer.name.trim(), new_customer.phone || '', now()).lastInsertRowid;
    custName = new_customer.name.trim();
  } else if (custId) {
    const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(custId);
    if (c) custName = c.name;
  }

  const getVariant = db.prepare('SELECT * FROM variants WHERE id = ?');
  const lines = [];
  for (const it of items) {
    const v = getVariant.get(it.variant_id);
    if (!v) return res.status(400).json({ error: `Produto não encontrado (id ${it.variant_id}).` });
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    if (v.stock_management && v.stock < qty) return res.status(409).json({ error: `Estoque insuficiente de "${v.product_name} ${v.variant_name}" (tem ${v.stock}, pediu ${qty}).` });
    const unitPrice = it.unit_price != null ? parseFloat(it.unit_price) : v.price;
    lines.push({ v, qty, unitPrice, lineTotal: money(unitPrice * qty), unitCost: v.cost });
  }

  const subtotal = money(lines.reduce((s, l) => s + l.lineTotal, 0));
  const disc = money(Math.max(0, parseFloat(discount) || 0));
  const total = money(Math.max(0, subtotal - disc));
  const costTotal = money(lines.reduce((s, l) => s + l.unitCost * l.qty, 0));
  const margin = money(total - costTotal);
  const status = payment_status === 'pendente' ? 'pendente' : 'pago';
  const ts = now();
  const code = 'VN-' + String(db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM sales').get().n).padStart(6, '0');

  const saleId = db.transaction(() => {
    const id = db.prepare(`INSERT INTO sales (code, channel, customer_id, customer_name, payment_method, payment_status, paid_at, subtotal, discount, total, cost_total, margin, synced_nuvemshop, created_at)
      VALUES (?, 'pdv', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(code, custId, custName, payment_method, status, status === 'pago' ? ts : null, subtotal, disc, total, costTotal, margin, ts).lastInsertRowid;
    const insItem = db.prepare(`INSERT INTO sale_items (sale_id, variant_id, name, qty, unit_price, unit_cost, line_total) VALUES (?,?,?,?,?,?,?)`);
    const updStock = db.prepare('UPDATE variants SET stock = stock - ?, updated_at = ? WHERE id = ?');
    const insMove = db.prepare('INSERT INTO stock_movements (variant_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)');
    for (const l of lines) {
      insItem.run(id, l.v.id, `${l.v.product_name} ${l.v.variant_name}`, l.qty, l.unitPrice, l.unitCost, l.lineTotal);
      if (l.v.stock_management) { updStock.run(l.qty, ts, l.v.id); insMove.run(l.v.id, -l.qty, 'venda_pdv', code, ts); }
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
      try { await nuvem.setVariantStock(l.v.nuvemshop_product_id, l.v.nuvemshop_variant_id, Math.max(0, l.v.stock - l.qty)); }
      catch (err) { syncedAll = false; syncNotes.push(`${l.v.product_name} ${l.v.variant_name}: ${err.message}`); }
    }
  } else { syncedAll = false; syncNotes.push('Modo demonstração — estoque não enviado à Nuvemshop.'); }
  const live = isLive();
  db.prepare('UPDATE sales SET synced_nuvemshop=?, sync_note=? WHERE id=?').run(syncedAll && live ? 1 : 0, syncNotes.join(' | ') || null, saleId);

  res.json({ ok: true, code, total, margin, payment_status: status, customer_name: custName, mode: live ? 'live' : 'demo', stock_synced: syncedAll && live, notes: syncNotes });
});

// ==================== CONTAS A RECEBER (fiado) ====================
app.get('/api/receivables', (req, res) => {
  const rows = db.prepare(`SELECT id, code, customer_id, customer_name, total, payment_method, created_at FROM sales WHERE payment_status='pendente' ORDER BY created_at ASC`).all();
  const total = db.prepare(`SELECT COALESCE(SUM(total),0) AS n FROM sales WHERE payment_status='pendente'`).get().n;
  res.json({ total: money(total), count: rows.length, items: rows });
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
  const lowStock = db.prepare('SELECT COUNT(*) AS n FROM variants WHERE stock_management = 1 AND stock <= 4').get().n;
  const recv = db.prepare(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM sales WHERE payment_status='pendente'`).get();
  const stockVal = db.prepare('SELECT COALESCE(SUM(stock*cost),0) AS v FROM variants WHERE stock_management = 1').get().v;
  const recent = db.prepare('SELECT code, customer_name, payment_method, payment_status, total, created_at, synced_nuvemshop FROM sales ORDER BY id DESC LIMIT 8').all();
  const lowList = db.prepare('SELECT product_name, variant_name, stock FROM variants WHERE stock_management = 1 AND stock <= 4 ORDER BY stock ASC LIMIT 8').all();
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
  const despesa = db.prepare(`SELECT COALESCE(SUM(amount),0) n FROM financial_entries WHERE type='despesa' ${cond}`).get(...a).n;
  const aReceber = db.prepare("SELECT COALESCE(SUM(total),0) n FROM sales WHERE payment_status='pendente'").get().n;
  const byMethod = db.prepare(`SELECT COALESCE(NULLIF(payment_method,''),'—') label, COUNT(*) n, COALESCE(SUM(total),0) total
    FROM sales WHERE payment_status='pago' ${cond} GROUP BY payment_method ORDER BY total DESC`).all(...a);
  const entries = db.prepare(`SELECT id, type, category, description, amount, ref, created_at FROM financial_entries
    ${since ? 'WHERE created_at >= ?' : ''} ORDER BY id DESC LIMIT 120`).all(...a);
  // Por categoria (o coração da gestão): entra e sai, agrupado.
  const porCategoria = (tipo) => db.prepare(`SELECT COALESCE(NULLIF(category,''),'Sem categoria') label,
      COUNT(*) n, COALESCE(SUM(amount),0) total FROM financial_entries
      WHERE type = ? ${cond} GROUP BY label ORDER BY total DESC`).all(tipo, ...a);
  // Receita por origem (PDV x Site) — as duas frentes.
  const porOrigem = db.prepare(`SELECT CASE WHEN channel='site' THEN 'Site' ELSE 'PDV' END origem,
      COUNT(*) n, COALESCE(SUM(total),0) total FROM sales
      WHERE payment_status='pago' ${cond} GROUP BY origem ORDER BY total DESC`).all(...a);
  res.json({
    period, receita: money(receita), despesa: money(despesa), saldo: money(receita - despesa),
    a_receber: money(aReceber), by_method: byMethod, entries,
    por_categoria_receita: porCategoria('receita'), por_categoria_despesa: porCategoria('despesa'),
    por_origem: porOrigem, ultima_importacao: getSetting('last_orders_import'),
  });
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
// Compatibilidade com a versão anterior
app.post('/api/financial/expense', (req, res) => {
  req.body = { ...(req.body || {}), type: 'despesa' };
  const b = req.body;
  const amount = money(b.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Informe um valor maior que zero.' });
  const catName = (b.category || '').trim() || 'Outras despesas';
  db.prepare(`INSERT INTO financial_entries (type, category, category_id, description, amount, created_at)
    VALUES ('despesa',?,?,?,?,?)`).run(catName, categoryId(catName, 'despesa'), b.description || catName, amount, now());
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
  const ins = db.prepare(`INSERT INTO customers (nuvemshop_customer_id, name, phone, email, created_at) VALUES (?,?,?,?,?)`);
  const upd = db.prepare('UPDATE customers SET nuvemshop_customer_id=?, phone=COALESCE(NULLIF(phone,\'\'),?), email=COALESCE(NULLIF(email,\'\'),?) WHERE id=?');

  let novos = 0, vinculados = 0;
  db.transaction(() => {
    for (const c of lista) {
      const nsId = String(c.id);
      const nome = (c.name || c.email || 'Cliente').trim();
      const email = (c.email || '').trim();
      const fone = (c.phone || (c.default_address && c.default_address.phone) || '').trim();
      if (porNs.get(nsId)) continue;
      // Já existe aqui (cadastrado no PDV)? Então só liga os dois.
      // O nome só serve para casar se identificar mesmo a pessoa.
      const existente = (email && porEmail.get(email)) || (nomeUtil(nome) ? porNome.get(nome) : null);
      if (existente) { upd.run(nsId, fone, email, existente.id); vinculados += 1; continue; }
      ins.run(nsId, nome, fone, email, c.created_at ? new Date(c.created_at).toISOString() : now());
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
  const suspeitos = db.prepare('SELECT id, name, nuvemshop_customer_id FROM customers').all()
    .filter((c) => !nomeUtil(c.name) && !c.nuvemshop_customer_id);
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
  const criarCliente = db.prepare('INSERT INTO customers (nuvemshop_customer_id, name, phone, email, created_at) VALUES (?,?,?,?,?)');
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
  if (sincronizando || !isLive()) return;
  sincronizando = true;
  try {
    const r = await sincronizarPedidos();
    if (r && !r.skipped && (r.novos || r.lancados)) {
      console.log(`› Pedidos do site (${motivo}): ${r.novos} novo(s), ${r.lancados} lançado(s) no caixa.`);
    }
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
    const rank = db.prepare(`SELECT COUNT(*) n FROM (
      SELECT customer_id FROM sales WHERE customer_id IS NOT NULL GROUP BY customer_id)`).get().n;
    res.json({
      ok: true,
      clientes: cli,
      pedidos: { novos: ped.novos || 0, atualizados: ped.atualizados || 0, analisados: ped.analisados || 0, desde: ped.desde },
      pedidos_vinculados: ligados,
      corrigidos: limpeza,
      clientes_com_historico: rank,
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Disparo manual (a tela usa para "atualizar agora")
app.post('/api/import-orders', async (req, res) => {
  if (!isLive()) return res.status(400).json({ error: 'Conecte a loja primeiro.' });
  try {
    const r = await sincronizarPedidos(parseInt((req.body || {}).days, 10) || 45);
    res.json({ ok: true, ...r });
  } catch (err) { res.status(502).json({ error: err.message }); }
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
app.get('/produtos', page('produtos.html'));
app.get('/estoque', page('produtos.html'));
app.get('/financeiro', page('financeiro.html'));
app.get('/agentes', page('agentes.html'));
app.get('/lembretes', page('lembretes.html'));
app.get('/ajuda', page('ajuda.html'));
app.get('/como-usar', page('ajuda.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🐊 VN Store — Sistema no ar na porta ${PORT}`);
  console.log(`     Modo: ${isLive() ? 'AO VIVO (Nuvemshop conectada)' : 'DEMONSTRAÇÃO (sem token)'}`);
  console.log(`     Login: ${APP_PASSWORD ? 'com senha (APP_PASSWORD)' : 'aberto (sem senha)'}\n`);
});

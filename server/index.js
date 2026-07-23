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
import db, { seedDemoIfEmpty } from './db.js';
import * as nuvem from './nuvemshop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const UPLOADS = join(PUBLIC, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC));

const LIVE = nuvem.isConfigured();
const now = () => new Date().toISOString();
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nameOf = (obj) => {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj.pt || obj.es || obj.en || Object.values(obj)[0] || '';
};

if (!LIVE && seedDemoIfEmpty()) console.log('› Modo demonstração: catálogo e clientes de exemplo criados.');

// ---------------------- Saúde ----------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: LIVE ? 'live' : 'demo',
    store_id: LIVE ? nuvem.nuvemshopConfig.STORE_ID : null,
    products: db.prepare('SELECT COUNT(*) AS n FROM products').get().n,
    variants: db.prepare('SELECT COUNT(*) AS n FROM variants').get().n,
  });
});

// ==================== PRODUTOS (PDV) ====================
app.get('/api/products', (req, res) => {
  const q = (req.query.q || '').trim();
  const base = `SELECT v.*, p.brand, p.category FROM variants v LEFT JOIN products p ON p.id = v.product_id`;
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
  if (cat) { where.push('p.category = ?'); args.push(cat); }
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
    SELECT COALESCE(p.category,'(sem categoria)') AS label,
           COUNT(DISTINCT p.id) AS products,
           COALESCE(SUM(v.stock),0) AS units,
           COALESCE(SUM(v.stock * v.cost),0) AS value_cost
    FROM products p LEFT JOIN variants v ON v.product_id = p.id
    GROUP BY p.category ORDER BY value_cost DESC
  `).all();
  const byBrand = db.prepare(`
    SELECT COALESCE(p.brand,'(sem marca)') AS label,
           COUNT(DISTINCT p.id) AS products,
           COALESCE(SUM(v.stock),0) AS units,
           COALESCE(SUM(v.stock * v.cost),0) AS value_cost
    FROM products p LEFT JOIN variants v ON v.product_id = p.id
    GROUP BY p.brand ORDER BY value_cost DESC
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
    const pid = db.prepare(`INSERT INTO products (name, brand, category, description, image_url, published, synced_nuvemshop, created_at, updated_at)
      VALUES (?,?,?,?,?,?,0,?,?)`).run(String(b.name).trim(), b.brand || '', b.category || '', b.description || '', b.image_url || '', b.published === false ? 0 : 1, ts, ts).lastInsertRowid;
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
    db.prepare(`UPDATE products SET name=?, brand=?, category=?, description=?, image_url=?, published=?, updated_at=? WHERE id=?`)
      .run(b.name ?? p.name, b.brand ?? p.brand, b.category ?? p.category, b.description ?? p.description, b.image_url ?? p.image_url, b.published === false ? 0 : 1, ts, p.id);
    if (Array.isArray(b.variants)) {
      const upd = db.prepare('UPDATE variants SET variant_name=?, sku=?, price=?, cost=?, stock=?, product_name=?, updated_at=? WHERE id=? AND product_id=?');
      const insV = db.prepare(`INSERT INTO variants (product_id, product_name, variant_name, sku, price, cost, stock, stock_management, updated_at) VALUES (?,?,?,?,?,?,?,1,?)`);
      for (const v of b.variants) {
        if (v.id) upd.run(v.variant_name || 'Único', v.sku || '', money(v.price), money(v.cost), parseInt(v.stock, 10) || 0, b.name ?? p.name, ts, v.id, p.id);
        else insV.run(p.id, b.name ?? p.name, v.variant_name || 'Único', v.sku || '', money(v.price), money(v.cost), parseInt(v.stock, 10) || 0, ts);
      }
    }
  })();
  const sync = await pushProduct(p.id);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(p.id);
  product.variants = db.prepare('SELECT * FROM variants WHERE product_id = ?').all(p.id);
  res.json({ ok: true, product, sync });
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
  if (!LIVE) {
    db.prepare('UPDATE products SET synced_nuvemshop=0, sync_note=? WHERE id=?').run('Modo demonstração — não enviado à Nuvemshop.', productId);
    return { mode: 'demo', ok: false, note: 'Modo demonstração — conecte a Nuvemshop para publicar.' };
  }
  try {
    const hasSizes = variants.some((v) => v.variant_name && v.variant_name !== 'Único');
    const payload = { name: { pt: p.name }, description: { pt: p.description || '' } };
    if (hasSizes) {
      payload.attributes = [{ pt: 'Tamanho' }];
      payload.variants = variants.map((v) => ({ price: String(v.price), stock: parseInt(v.stock, 10) || 0, sku: v.sku || '', values: [{ pt: v.variant_name }] }));
    } else {
      payload.variants = variants.map((v) => ({ price: String(v.price), stock: parseInt(v.stock, 10) || 0, sku: v.sku || '' }));
    }
    // Categoria: resolve por nome (cria se faltar).
    if (p.category) {
      try {
        const cats = await nuvem.listCategories();
        let match = cats.find((c) => nameOf(c.name).toLowerCase() === p.category.toLowerCase());
        if (!match) match = await nuvem.createCategory(p.category);
        if (match && match.id) payload.categories = [match.id];
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
    // Imagem principal: se foi enviada pra cá, mandamos o arquivo (base64);
    // se é uma URL externa, mandamos a URL. (best-effort)
    if (p.image_url) {
      try {
        if (p.image_url.startsWith('/uploads/')) {
          const b64 = fs.readFileSync(join(PUBLIC, p.image_url)).toString('base64');
          await nuvem.addProductImage(result.id, { attachment: b64, filename: p.image_url.split('/').pop() });
        } else {
          await nuvem.addProductImage(result.id, { src: p.image_url });
        }
      } catch (e) { /* imagem é best-effort */ }
    }

    return { mode: 'live', ok: true, nuvemshop_product_id: String(result.id) };
  } catch (err) {
    db.prepare('UPDATE products SET synced_nuvemshop=0, sync_note=? WHERE id=?').run(err.message, productId);
    return { mode: 'live', ok: false, note: err.message };
  }
}

// ==================== SINCRONIZAR (puxar da Nuvemshop) ====================
app.post('/api/sync', async (req, res) => {
  if (!LIVE) { const seeded = seedDemoIfEmpty(); return res.json({ mode: 'demo', seeded, message: 'Modo demonstração — sem loja conectada.' }); }
  try {
    const products = await nuvem.listAllProducts();
    const upP = db.prepare(`INSERT INTO products (nuvemshop_product_id, name, category, description, image_url, published, synced_nuvemshop, created_at, updated_at)
      VALUES (@pid,@name,@category,@description,@image,1,1,@now,@now)
      ON CONFLICT(nuvemshop_product_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`);
    const getP = db.prepare('SELECT id FROM products WHERE nuvemshop_product_id = ?');
    const upV = db.prepare(`INSERT INTO variants (product_id, nuvemshop_product_id, nuvemshop_variant_id, product_name, variant_name, sku, price, cost, stock, stock_management, updated_at)
      VALUES (@product_id,@pid,@vid,@pname,@vname,@sku,@price,@cost,@stock,@sm,@now)
      ON CONFLICT(nuvemshop_variant_id) DO UPDATE SET product_name=excluded.product_name, variant_name=excluded.variant_name, sku=excluded.sku, price=excluded.price, stock=excluded.stock, stock_management=excluded.stock_management, updated_at=excluded.updated_at`);
    let variantCount = 0;
    db.transaction(() => {
      for (const p of products) {
        const name = nameOf(p.name);
        const image = (p.images && p.images[0] && p.images[0].src) || '';
        const category = (p.categories && p.categories[0] && nameOf(p.categories[0].name)) || '';
        upP.run({ pid: String(p.id), name, category, description: nameOf(p.description), image, now: now() });
        const productId = getP.get(String(p.id)).id;
        for (const v of (p.variants || [])) {
          const vname = (v.values || []).map((x) => nameOf(x)).join(' / ') || 'Único';
          upV.run({ product_id: productId, pid: String(p.id), vid: String(v.id), pname: name, vname, sku: v.sku || '', price: parseFloat(v.price) || 0, cost: 0, stock: v.stock == null ? 0 : parseInt(v.stock, 10), sm: v.stock_management === false ? 0 : 1, now: now() });
          variantCount += 1;
        }
      }
    })();
    res.json({ mode: 'live', products: products.length, variants: variantCount });
  } catch (err) {
    console.error('Sync falhou:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ==================== CLIENTES ====================
// Ranking: quanto cada cliente já gastou + pendências.
app.get('/api/customers', (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT c.*,
      COUNT(s.id) AS orders,
      COALESCE(SUM(s.total),0) AS total_spent,
      COALESCE(SUM(CASE WHEN s.payment_status='pendente' THEN s.total ELSE 0 END),0) AS pending,
      MAX(s.created_at) AS last_purchase
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
  const agg = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS total_spent,
    COALESCE(SUM(CASE WHEN payment_status='pendente' THEN total ELSE 0 END),0) AS pending FROM sales WHERE customer_id = ?`).get(c.id);
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
    if (status === 'pago') db.prepare(`INSERT INTO financial_entries (type, category, description, amount, ref, created_at) VALUES ('receita','venda_pdv',?,?,?,?)`).run(`Venda PDV ${code}`, total, code, ts);
    return id;
  })();

  // Empurra o novo estoque para a Nuvemshop.
  let syncedAll = true; const syncNotes = [];
  if (LIVE) {
    for (const l of lines) {
      if (!l.v.stock_management || !l.v.nuvemshop_product_id || !l.v.nuvemshop_variant_id) continue;
      try { await nuvem.setVariantStock(l.v.nuvemshop_product_id, l.v.nuvemshop_variant_id, Math.max(0, l.v.stock - l.qty)); }
      catch (err) { syncedAll = false; syncNotes.push(`${l.v.product_name} ${l.v.variant_name}: ${err.message}`); }
    }
  } else { syncedAll = false; syncNotes.push('Modo demonstração — estoque não enviado à Nuvemshop.'); }
  db.prepare('UPDATE sales SET synced_nuvemshop=?, sync_note=? WHERE id=?').run(syncedAll && LIVE ? 1 : 0, syncNotes.join(' | ') || null, saleId);

  res.json({ ok: true, code, total, margin, payment_status: status, customer_name: custName, mode: LIVE ? 'live' : 'demo', stock_synced: syncedAll && LIVE, notes: syncNotes });
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
  db.transaction(() => {
    db.prepare("UPDATE sales SET payment_status='pago', paid_at=?, payment_method=? WHERE id=?").run(ts, method, s.id);
    db.prepare(`INSERT INTO financial_entries (type, category, description, amount, ref, created_at) VALUES ('receita','venda_pdv',?,?,?,?)`).run(`Recebimento ${s.code}`, s.total, s.code, ts);
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
  res.json({
    mode: LIVE ? 'live' : 'demo',
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
  const entries = db.prepare(`SELECT type, category, description, amount, ref, created_at FROM financial_entries
    ${since ? 'WHERE created_at >= ?' : ''} ORDER BY id DESC LIMIT 80`).all(...a);
  res.json({ period, receita: money(receita), despesa: money(despesa), saldo: money(receita - despesa), a_receber: money(aReceber), by_method: byMethod, entries });
});

app.post('/api/financial/expense', (req, res) => {
  const b = req.body || {};
  const amount = money(b.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Informe um valor maior que zero.' });
  db.prepare("INSERT INTO financial_entries (type, category, description, amount, created_at) VALUES ('despesa', ?, ?, ?, ?)")
    .run(b.category || 'geral', b.description || 'Despesa', amount, now());
  res.json({ ok: true });
});

// Páginas
const page = (f) => (req, res) => res.sendFile(join(__dirname, '..', 'public', f));
app.get('/pdv', page('pdv.html'));
app.get('/clientes', page('clientes.html'));
app.get('/produtos', page('produtos.html'));
app.get('/estoque', page('produtos.html'));
app.get('/financeiro', page('financeiro.html'));
app.get('/agentes', page('agentes.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  🐊 VN Store — Sistema no ar em http://localhost:${PORT}`);
  console.log(`     Modo: ${LIVE ? 'AO VIVO (Nuvemshop conectada)' : 'DEMONSTRAÇÃO (sem token)'}\n`);
});

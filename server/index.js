// ============================================================
//  Servidor VN Store — API + painel + PDV.
//  Roda em "modo demonstração" sem token; fica ao vivo quando
//  o .env com as credenciais da Nuvemshop é preenchido.
// ============================================================
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db, { seedDemoIfEmpty } from './db.js';
import * as nuvem from './nuvemshop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const LIVE = nuvem.isConfigured();
const now = () => new Date().toISOString();
const money = (n) => Math.round(n * 100) / 100;

// Semente de demonstração só quando NÃO está ao vivo e o banco está vazio.
if (!LIVE) {
  const seeded = seedDemoIfEmpty();
  if (seeded) console.log('› Modo demonstração: produtos de exemplo criados.');
}

// ---------------------- Saúde / status ----------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: LIVE ? 'live' : 'demo',
    store_id: LIVE ? nuvem.nuvemshopConfig.STORE_ID : null,
    variants: db.prepare('SELECT COUNT(*) AS n FROM variants').get().n,
  });
});

// ---------------------- Produtos (para o PDV) ----------------------
app.get('/api/products', (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = db.prepare(`
      SELECT * FROM variants
      WHERE product_name LIKE ? OR variant_name LIKE ? OR sku LIKE ?
      ORDER BY product_name, variant_name LIMIT 100
    `).all(like, like, like);
  } else {
    rows = db.prepare('SELECT * FROM variants ORDER BY product_name, variant_name LIMIT 100').all();
  }
  res.json(rows);
});

// ---------------------- Sincronizar com a Nuvemshop ----------------------
// Puxa produtos/variantes da loja para o banco local. Preserva o custo
// (que só existe aqui). Em modo demo, apenas garante a semente.
app.post('/api/sync', async (req, res) => {
  if (!LIVE) {
    const seeded = seedDemoIfEmpty();
    return res.json({ mode: 'demo', seeded, message: 'Modo demonstração — sem loja conectada.' });
  }
  try {
    const products = await nuvem.listAllProducts();
    const upsert = db.prepare(`
      INSERT INTO variants (nuvemshop_product_id, nuvemshop_variant_id, product_name, variant_name, sku, price, cost, stock, stock_management, updated_at)
      VALUES (@pid, @vid, @product_name, @variant_name, @sku, @price, @cost, @stock, @stock_management, @updated_at)
      ON CONFLICT(nuvemshop_variant_id) DO UPDATE SET
        product_name=excluded.product_name,
        variant_name=excluded.variant_name,
        sku=excluded.sku,
        price=excluded.price,
        stock=excluded.stock,
        stock_management=excluded.stock_management,
        updated_at=excluded.updated_at
    `);
    let variantCount = 0;
    const nameOf = (obj) => {
      if (!obj) return '';
      if (typeof obj === 'string') return obj;
      return obj.pt || obj.es || obj.en || Object.values(obj)[0] || '';
    };
    const tx = db.transaction((list) => {
      for (const p of list) {
        const productName = nameOf(p.name);
        for (const v of (p.variants || [])) {
          const vName = (v.values || []).map((x) => nameOf(x)).join(' / ');
          upsert.run({
            pid: String(p.id),
            vid: String(v.id),
            product_name: productName,
            variant_name: vName || 'Único',
            sku: v.sku || '',
            price: parseFloat(v.price) || 0,
            cost: 0, // custo é preenchido por nós; não vem da Nuvemshop
            stock: v.stock == null ? 0 : parseInt(v.stock, 10),
            stock_management: v.stock_management === false ? 0 : 1,
            updated_at: now(),
          });
          variantCount += 1;
        }
      }
    });
    tx(products);
    res.json({ mode: 'live', products: products.length, variants: variantCount });
  } catch (err) {
    console.error('Sync falhou:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------- Lançar venda no PDV ----------------------
// Corpo: { items:[{variant_id, qty, unit_price?}], customer_name, payment_method, discount }
app.post('/api/sales', async (req, res) => {
  const { items = [], customer_name = '', payment_method = '', discount = 0 } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Adicione ao menos um item à venda.' });
  }

  // Monta a venda e valida estoque ANTES de gravar.
  const getVariant = db.prepare('SELECT * FROM variants WHERE id = ?');
  const lines = [];
  for (const it of items) {
    const v = getVariant.get(it.variant_id);
    if (!v) return res.status(400).json({ error: `Produto não encontrado (id ${it.variant_id}).` });
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    if (v.stock_management && v.stock < qty) {
      return res.status(409).json({ error: `Estoque insuficiente de "${v.product_name} ${v.variant_name}" (tem ${v.stock}, pediu ${qty}).` });
    }
    const unitPrice = it.unit_price != null ? parseFloat(it.unit_price) : v.price;
    lines.push({ v, qty, unitPrice, lineTotal: money(unitPrice * qty), unitCost: v.cost });
  }

  const subtotal = money(lines.reduce((s, l) => s + l.lineTotal, 0));
  const disc = money(Math.max(0, parseFloat(discount) || 0));
  const total = money(Math.max(0, subtotal - disc));
  const costTotal = money(lines.reduce((s, l) => s + l.unitCost * l.qty, 0));
  const margin = money(total - costTotal);

  // Código sequencial VN-000001
  const nextId = (db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM sales').get().n);
  const code = 'VN-' + String(nextId).padStart(6, '0');
  const ts = now();

  // Grava tudo numa transação (venda, itens, baixa local, financeiro).
  const write = db.transaction(() => {
    const saleId = db.prepare(`
      INSERT INTO sales (code, channel, customer_name, payment_method, subtotal, discount, total, cost_total, margin, synced_nuvemshop, created_at)
      VALUES (?, 'pdv', ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(code, customer_name, payment_method, subtotal, disc, total, costTotal, margin, ts).lastInsertRowid;

    const insItem = db.prepare(`INSERT INTO sale_items (sale_id, variant_id, name, qty, unit_price, unit_cost, line_total) VALUES (?,?,?,?,?,?,?)`);
    const updStock = db.prepare('UPDATE variants SET stock = stock - ?, updated_at = ? WHERE id = ?');
    const insMove = db.prepare('INSERT INTO stock_movements (variant_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)');
    for (const l of lines) {
      insItem.run(saleId, l.v.id, `${l.v.product_name} ${l.v.variant_name}`, l.qty, l.unitPrice, l.unitCost, l.lineTotal);
      if (l.v.stock_management) {
        updStock.run(l.qty, ts, l.v.id);
        insMove.run(l.v.id, -l.qty, 'venda_pdv', code, ts);
      }
    }
    db.prepare(`INSERT INTO financial_entries (type, category, description, amount, ref, created_at) VALUES ('receita','venda_pdv',?,?,?,?)`)
      .run(`Venda PDV ${code}`, total, code, ts);
    return saleId;
  });
  const saleId = write();

  // Empurra o novo estoque para a Nuvemshop (fora da transação do banco).
  let syncedAll = true;
  const syncNotes = [];
  if (LIVE) {
    for (const l of lines) {
      if (!l.v.stock_management || !l.v.nuvemshop_product_id || !l.v.nuvemshop_variant_id) continue;
      const newStock = Math.max(0, l.v.stock - l.qty);
      try {
        await nuvem.setVariantStock(l.v.nuvemshop_product_id, l.v.nuvemshop_variant_id, newStock);
      } catch (err) {
        syncedAll = false;
        syncNotes.push(`${l.v.product_name} ${l.v.variant_name}: ${err.message}`);
      }
    }
  } else {
    syncedAll = false;
    syncNotes.push('Modo demonstração — estoque não enviado à Nuvemshop.');
  }

  db.prepare('UPDATE sales SET synced_nuvemshop = ?, sync_note = ? WHERE id = ?')
    .run(syncedAll && LIVE ? 1 : 0, syncNotes.join(' | ') || null, saleId);

  res.json({
    ok: true,
    code,
    total,
    margin,
    mode: LIVE ? 'live' : 'demo',
    stock_synced: syncedAll && LIVE,
    notes: syncNotes,
    items: lines.map((l) => ({ name: `${l.v.product_name} ${l.v.variant_name}`, qty: l.qty, line_total: l.lineTotal })),
  });
});

// ---------------------- Painel (KPIs ao vivo) ----------------------
app.get('/api/dashboard', (req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const iso = startOfDay.toISOString();
  const today = db.prepare(`
    SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(margin),0) AS margin
    FROM sales WHERE created_at >= ?
  `).get(iso);
  const ticket = today.orders > 0 ? money(today.revenue / today.orders) : 0;
  const lowStock = db.prepare('SELECT COUNT(*) AS n FROM variants WHERE stock_management = 1 AND stock <= 4').get().n;
  const marginPct = today.revenue > 0 ? Math.round((today.margin / today.revenue) * 100) : 0;
  const recent = db.prepare('SELECT code, customer_name, payment_method, total, created_at, synced_nuvemshop FROM sales ORDER BY id DESC LIMIT 8').all();
  const lowList = db.prepare('SELECT product_name, variant_name, stock FROM variants WHERE stock_management = 1 AND stock <= 4 ORDER BY stock ASC LIMIT 8').all();
  res.json({
    mode: LIVE ? 'live' : 'demo',
    revenue_today: money(today.revenue),
    orders_today: today.orders,
    ticket,
    margin_pct: marginPct,
    low_stock: lowStock,
    recent_sales: recent,
    low_stock_list: lowList,
  });
});

// Rotas de página
app.get('/pdv', (req, res) => res.sendFile(join(__dirname, '..', 'public', 'pdv.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  🐊 VN Store — Sistema no ar em http://localhost:${PORT}`);
  console.log(`     Modo: ${LIVE ? 'AO VIVO (Nuvemshop conectada)' : 'DEMONSTRAÇÃO (sem token)'}`);
  console.log(`     PDV:  http://localhost:${PORT}/pdv\n`);
});

// ============================================================
//  Banco de dados (SQLite) — o "corpo" do sistema.
//  Guarda o que a Nuvemshop NÃO guarda: custo, marca, valor de
//  estoque a custo, clientes com histórico, vendas fiado, etc.
//  Nosso sistema é o DONO do cadastro; a Nuvemshop é o espelho
//  (vitrine) — a gente cria/atualiza lá via API.
// ============================================================
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'vnstore.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  nuvemshop_product_id  TEXT UNIQUE,
  name                  TEXT NOT NULL,
  brand                 TEXT,               -- marca (só nosso)
  category              TEXT,               -- categoria
  description           TEXT,
  image_url             TEXT,               -- foto principal (URL)
  published             INTEGER NOT NULL DEFAULT 1,
  synced_nuvemshop      INTEGER NOT NULL DEFAULT 0,
  sync_note             TEXT,
  created_at            TEXT,
  updated_at            TEXT
);

CREATE TABLE IF NOT EXISTS variants (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id            INTEGER REFERENCES products(id) ON DELETE CASCADE,
  nuvemshop_product_id  TEXT,
  nuvemshop_variant_id  TEXT UNIQUE,
  product_name          TEXT NOT NULL,      -- denormalizado p/ o PDV
  variant_name          TEXT,               -- ex.: "P" ou "P / Verde"
  sku                   TEXT,
  price                 REAL NOT NULL DEFAULT 0,
  cost                  REAL NOT NULL DEFAULT 0,    -- custo (só nosso)
  stock                 INTEGER NOT NULL DEFAULT 0,
  stock_management      INTEGER NOT NULL DEFAULT 1,
  updated_at            TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  nuvemshop_customer_id TEXT,
  name                  TEXT NOT NULL,
  phone                 TEXT,
  email                 TEXT,
  note                  TEXT,
  created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT UNIQUE,
  channel           TEXT NOT NULL DEFAULT 'pdv',
  customer_id       INTEGER REFERENCES customers(id),
  customer_name     TEXT,
  payment_method    TEXT,
  payment_status    TEXT NOT NULL DEFAULT 'pago',   -- pago | pendente
  paid_at           TEXT,
  subtotal          REAL NOT NULL DEFAULT 0,
  discount          REAL NOT NULL DEFAULT 0,
  total             REAL NOT NULL DEFAULT 0,
  cost_total        REAL NOT NULL DEFAULT 0,
  margin            REAL NOT NULL DEFAULT 0,
  synced_nuvemshop  INTEGER NOT NULL DEFAULT 0,
  sync_note         TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sale_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id     INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  variant_id  INTEGER REFERENCES variants(id),
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  unit_price  REAL NOT NULL,
  unit_cost   REAL NOT NULL DEFAULT 0,
  line_total  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id  INTEGER REFERENCES variants(id),
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,        -- venda_pdv | ajuste | entrada | sync
  ref         TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,        -- receita | despesa
  category    TEXT NOT NULL,        -- venda_pdv | ...
  description TEXT,
  amount      REAL NOT NULL,
  ref         TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- Plano de contas: categorias de receita e despesa
CREATE TABLE IF NOT EXISTS fin_categories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,              -- receita | despesa
  is_system INTEGER NOT NULL DEFAULT 0, -- padrão do sistema (não apaga)
  archived  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  UNIQUE(name, kind)
);

-- Lembretes: o que não pode ser esquecido
CREATE TABLE IF NOT EXISTS reminders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  notes       TEXT,
  due_date    TEXT,                       -- AAAA-MM-DD
  kind        TEXT NOT NULL DEFAULT 'geral', -- geral | pagamento | encomenda | reposicao
  customer_id INTEGER REFERENCES customers(id),
  amount      REAL,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rem_due ON reminders(due_date, done);

CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(payment_status);
CREATE INDEX IF NOT EXISTS idx_variants_stock ON variants(stock);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);
`);

// ---- Configurações (credenciais da Nuvemshop etc.) ----
export function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value == null ? null : String(value));
}

// ---- Migração defensiva (caso um banco antigo já exista) ----
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('products', 'categories_all', 'categories_all TEXT');
ensureColumn('products', 'image_sent', 'image_sent TEXT');      // qual foto já subiu (evita duplicar)
ensureColumn('products', 'ns_image_id', 'ns_image_id TEXT');    // id da foto na Nuvemshop
ensureColumn('products', 'weight', 'weight REAL');              // kg — a loja usa para calcular frete
ensureColumn('financial_entries', 'category_id', 'category_id INTEGER');
ensureColumn('sales', 'nuvemshop_order_id', 'nuvemshop_order_id TEXT');
// Status operacionais do pedido do site (espelho da Nuvemshop)
ensureColumn('sales', 'ns_payment_status', 'ns_payment_status TEXT');
ensureColumn('sales', 'ns_shipping_status', 'ns_shipping_status TEXT');
ensureColumn('sales', 'ns_status', 'ns_status TEXT');
ensureColumn('sales', 'ns_shipping_type', 'ns_shipping_type TEXT'); // envio | retirada
ensureColumn('sales', 'items_count', 'items_count INTEGER DEFAULT 0');
ensureColumn('sales', 'fin_posted', 'fin_posted INTEGER NOT NULL DEFAULT 0');
ensureColumn('sales', 'ns_customer_id', 'ns_customer_id TEXT'); // cliente do pedido na loja
ensureColumn('customers', 'instagram', 'instagram TEXT');       // @ do cliente (como a loja identifica)
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_order ON sales(nuvemshop_order_id) WHERE nuvemshop_order_id IS NOT NULL'); } catch (_) {}

// ---- Plano de contas padrão (criado uma vez) ----
export function seedCategories() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM fin_categories').get().n;
  if (n > 0) return false;
  const ins = db.prepare('INSERT OR IGNORE INTO fin_categories (name, kind, is_system, created_at) VALUES (?,?,1,?)');
  const now = new Date().toISOString();
  const receitas = ['Venda PDV', 'Venda Site', 'Outras receitas'];
  const despesas = ['Compra de mercadoria', 'Frete e envio', 'Taxas e maquininha', 'Marketing e anúncios',
    'Embalagens', 'Aluguel', 'Salários e retiradas', 'Impostos', 'Ferramentas e assinaturas', 'Outras despesas'];
  db.transaction(() => {
    receitas.forEach((r) => ins.run(r, 'receita', now));
    despesas.forEach((d) => ins.run(d, 'despesa', now));
  })();
  return true;
}
// Lançamentos antigos usavam rótulos técnicos ("venda_pdv", "compras").
// Traduz uma vez para os nomes do plano de contas.
export function migrateOldCategories() {
  const de_para = {
    venda_pdv: ['Venda PDV', 'receita'], venda_site: ['Venda Site', 'receita'],
    compras: ['Compra de mercadoria', 'despesa'], operação: ['Frete e envio', 'despesa'],
    operacao: ['Frete e envio', 'despesa'], marketing: ['Marketing e anúncios', 'despesa'],
    geral: ['Outras despesas', 'despesa'],
  };
  const alvo = db.prepare('SELECT DISTINCT category FROM financial_entries WHERE category_id IS NULL').all();
  if (!alvo.length) return 0;
  const upd = db.prepare('UPDATE financial_entries SET category = ?, category_id = ? WHERE category = ? AND category_id IS NULL');
  let n = 0;
  db.transaction(() => {
    for (const { category } of alvo) {
      if (!category) continue;
      const par = de_para[category];
      const kind = par ? par[1] : (db.prepare('SELECT type FROM financial_entries WHERE category = ? LIMIT 1').get(category) || {}).type || 'despesa';
      const nome = par ? par[0] : category;
      upd.run(nome, categoryId(nome, kind), category);
      n += 1;
    }
  })();
  return n;
}

export function categoryId(name, kind) {
  const r = db.prepare('SELECT id FROM fin_categories WHERE name = ? AND kind = ?').get(name, kind);
  if (r) return r.id;
  return db.prepare('INSERT INTO fin_categories (name, kind, is_system, created_at) VALUES (?,?,0,?)')
    .run(name, kind, new Date().toISOString()).lastInsertRowid;
}
ensureColumn('sales', 'customer_id', 'customer_id INTEGER');
ensureColumn('sales', 'payment_status', "payment_status TEXT NOT NULL DEFAULT 'pago'");
ensureColumn('sales', 'paid_at', 'paid_at TEXT');
ensureColumn('variants', 'product_id', 'product_id INTEGER');

// ---- Semente de demonstração (só se vazio) ----
export function seedDemoIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n
    + db.prepare('SELECT COUNT(*) AS n FROM variants').get().n;
  if (count > 0) return false;
  const now = new Date().toISOString();

  const insProduct = db.prepare(`
    INSERT INTO products (nuvemshop_product_id, name, brand, category, description, image_url, published, synced_nuvemshop, created_at, updated_at)
    VALUES (@pid, @name, @brand, @category, @description, @image_url, 1, 1, @now, @now)
  `);
  const insVariant = db.prepare(`
    INSERT INTO variants (product_id, nuvemshop_product_id, nuvemshop_variant_id, product_name, variant_name, sku, price, cost, stock, stock_management, updated_at)
    VALUES (@product_id, @pid, @vid, @product_name, @variant_name, @sku, @price, @cost, @stock, 1, @now)
  `);
  const insCustomer = db.prepare(`INSERT INTO customers (name, instagram, phone, email, created_at) VALUES (?,?,?,?,?)`);

  const catalog = [
    { name: 'Camiseta Quebrada Verde', brand: 'VN Store', category: 'Camisetas', description: 'Camiseta streetwear algodão premium.', image_url: '',
      variants: [ ['P','CAM-QV-P',89.9,38,4], ['M','CAM-QV-M',89.9,38,12], ['G','CAM-QV-G',89.9,38,9] ] },
    { name: 'Boné Branco Aba Curva', brand: 'VN Store', category: 'Bonés', description: 'Boné aba curva bordado.', image_url: '',
      variants: [ ['Único','BON-BR-U',129.9,52,7] ] },
    { name: 'Bermuda Moletom Verde', brand: 'VN Store', category: 'Bermudas', description: 'Bermuda moletom com bolso.', image_url: '',
      variants: [ ['M','BER-MV-M',149.9,61,5], ['G','BER-MV-G',149.9,61,2] ] },
    { name: 'Conjunto VN Street', brand: 'VN Store', category: 'Conjuntos', description: 'Conjunto camiseta + bermuda.', image_url: '',
      variants: [ ['M','CJ-VN-M',249.9,104,6] ] },
    { name: 'Corrente Prata Fina', brand: 'Acessórios VN', category: 'Acessórios', description: 'Corrente prata 45cm.', image_url: '',
      variants: [ ['Único','ACS-CP-U',79.9,28,15] ] },
  ];

  const tx = db.transaction(() => {
    let vseq = 2000;
    catalog.forEach((p, i) => {
      const pid = `demo-${1000 + i}`;
      insProduct.run({ pid, name: p.name, brand: p.brand, category: p.category, description: p.description, image_url: p.image_url, now });
      const productId = db.prepare('SELECT id FROM products WHERE nuvemshop_product_id = ?').get(pid).id;
      for (const [vn, sku, price, cost, stock] of p.variants) {
        insVariant.run({ product_id: productId, pid, vid: `demo-var-${vseq++}`, product_name: p.name, variant_name: vn, sku, price, cost, stock, now });
      }
    });
    // Muitos clientes da loja são conhecidos pelo @ — o exemplo reflete isso.
    insCustomer.run('Bianca Souza', '@bi.souza', '(11) 90000-0001', 'bianca@email.com', now);
    insCustomer.run('Rafael Lima', '', '(11) 90000-0002', 'rafael@email.com', now);
    insCustomer.run('@diego.alves', '@diego.alves', '(11) 90000-0003', '', now);
  });
  tx();
  return true;
}

export default db;

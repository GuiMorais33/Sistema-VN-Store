// ============================================================
//  Banco de dados (SQLite) — o "corpo" do sistema.
//  Guarda o que a Nuvemshop NÃO guarda: custo, margem, vendas
//  do PDV, movimentações de estoque e lançamentos financeiros.
// ============================================================
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'vnstore.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS variants (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  nuvemshop_product_id  TEXT,
  nuvemshop_variant_id  TEXT UNIQUE,
  product_name          TEXT NOT NULL,
  variant_name          TEXT,            -- ex.: "P / Verde"
  sku                   TEXT,
  price                 REAL NOT NULL DEFAULT 0,
  cost                  REAL NOT NULL DEFAULT 0,   -- custo (só nosso)
  stock                 INTEGER NOT NULL DEFAULT 0,
  stock_management      INTEGER NOT NULL DEFAULT 1,
  updated_at            TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT UNIQUE,
  channel           TEXT NOT NULL DEFAULT 'pdv',
  customer_name     TEXT,
  payment_method    TEXT,
  subtotal          REAL NOT NULL DEFAULT 0,
  discount          REAL NOT NULL DEFAULT 0,
  total             REAL NOT NULL DEFAULT 0,
  cost_total        REAL NOT NULL DEFAULT 0,
  margin            REAL NOT NULL DEFAULT 0,
  synced_nuvemshop  INTEGER NOT NULL DEFAULT 0,  -- 1 = estoque sincronizado
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
  delta       INTEGER NOT NULL,          -- negativo = saída
  reason      TEXT NOT NULL,             -- venda_pdv | ajuste | sync
  ref         TEXT,                      -- código da venda
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS financial_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,             -- receita | despesa
  category    TEXT NOT NULL,             -- venda_pdv | ...
  description TEXT,
  amount      REAL NOT NULL,
  ref         TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_variants_stock ON variants(stock);
`);

// ---- Semente de demonstração (só se o banco estiver vazio) ----
export function seedDemoIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM variants').get().n;
  if (count > 0) return false;
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO variants (nuvemshop_product_id, nuvemshop_variant_id, product_name, variant_name, sku, price, cost, stock, stock_management, updated_at)
    VALUES (@pid, @vid, @product_name, @variant_name, @sku, @price, @cost, @stock, 1, @updated_at)
  `);
  const demo = [
    { product_name: 'Camiseta Quebrada Verde', variant_name: 'P',  sku: 'CAM-QV-P',  price: 89.9,  cost: 38, stock: 4  },
    { product_name: 'Camiseta Quebrada Verde', variant_name: 'M',  sku: 'CAM-QV-M',  price: 89.9,  cost: 38, stock: 12 },
    { product_name: 'Camiseta Quebrada Verde', variant_name: 'G',  sku: 'CAM-QV-G',  price: 89.9,  cost: 38, stock: 9  },
    { product_name: 'Boné Branco Aba Curva',   variant_name: 'Único', sku: 'BON-BR-U', price: 129.9, cost: 52, stock: 7 },
    { product_name: 'Bermuda Moletom Verde',   variant_name: 'M',  sku: 'BER-MV-M',  price: 149.9, cost: 61, stock: 5  },
    { product_name: 'Bermuda Moletom Verde',   variant_name: 'G',  sku: 'BER-MV-G',  price: 149.9, cost: 61, stock: 2  },
    { product_name: 'Conjunto VN Street',      variant_name: 'M',  sku: 'CJ-VN-M',   price: 249.9, cost: 104, stock: 6 },
    { product_name: 'Corrente Prata Fina',     variant_name: 'Único', sku: 'ACS-CP-U', price: 79.9, cost: 28, stock: 15 },
  ];
  const tx = db.transaction((rows) => {
    rows.forEach((r, i) => insert.run({
      pid: `demo-${1000 + Math.floor(i / 3)}`,
      vid: `demo-var-${2000 + i}`,
      updated_at: now,
      ...r,
    }));
  });
  tx(demo);
  return true;
}

export default db;

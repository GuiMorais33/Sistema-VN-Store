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
// DB_FILE existe para teste rodar em banco separado. Em produção fica
// vazio e o banco é sempre o vnstore.db da pasta do sistema.
const db = new Database(process.env.DB_FILE || join(__dirname, '..', 'vnstore.db'));
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

-- Fornecedores: de quem a mercadoria vem
CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT DEFAULT '',
  note       TEXT DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(name)
);

-- Entrada de mercadoria: o que chegou, de quem, por quanto.
-- Uma compra mexe em três lugares de uma vez: estoque, custo e caixa.
CREATE TABLE IF NOT EXISTS purchases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE,
  supplier_id INTEGER REFERENCES suppliers(id),
  supplier_name TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  items_count INTEGER NOT NULL DEFAULT 0,
  total       REAL NOT NULL DEFAULT 0,
  freight     REAL NOT NULL DEFAULT 0,
  paid        INTEGER NOT NULL DEFAULT 1,   -- já saiu do caixa?
  due_date    TEXT,                          -- se a pagar, quando vence
  fin_posted  INTEGER NOT NULL DEFAULT 0,    -- já lançou a despesa?
  synced_nuvemshop INTEGER NOT NULL DEFAULT 0,
  sync_note   TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  variant_id  INTEGER REFERENCES variants(id),
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  unit_cost   REAL NOT NULL,
  line_total  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pitems_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);

-- Despesas fixas: aluguel, assinaturas, o que vence todo mês.
-- O sistema lança sozinho quando chega o dia, uma vez por mês.
CREATE TABLE IF NOT EXISTS fixed_expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL,
  category_id  INTEGER,
  amount       REAL NOT NULL,
  day_of_month INTEGER NOT NULL DEFAULT 1,   -- 1..28
  active       INTEGER NOT NULL DEFAULT 1,
  last_ym      TEXT,                          -- AAAA-MM do último lançamento
  created_at   TEXT NOT NULL
);

-- Equipe: quem trabalha na loja e o que cada um faz.
CREATE TABLE IF NOT EXISTS team_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'Vendedor',
  instagram  TEXT DEFAULT '',
  phone      TEXT DEFAULT '',
  vende      INTEGER NOT NULL DEFAULT 1,   -- aparece na hora de lançar a venda?
  active     INTEGER NOT NULL DEFAULT 1,
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(name)
);

-- Meta do mês por pessoa (ou da loja inteira, quando member_id é nulo).
CREATE TABLE IF NOT EXISTS goals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER REFERENCES team_members(id),
  ym         TEXT NOT NULL,                -- AAAA-MM
  target     REAL NOT NULL DEFAULT 0,      -- quanto precisa vender
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(member_id, ym)
);
CREATE INDEX IF NOT EXISTS idx_goals_ym ON goals(ym);

-- O sonho do vendedor. A meta não sai de planilha, sai daqui: a pessoa
-- diz o que quer conquistar e quanto custa, e a conta desce sozinha até
-- quantos atendimentos por dia isso dá.
CREATE TABLE IF NOT EXISTS dreams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id     INTEGER NOT NULL UNIQUE REFERENCES team_members(id),
  titulo        TEXT NOT NULL,                  -- "a entrada da moto"
  valor         REAL NOT NULL,                  -- quanto custa
  prazo_meses   INTEGER NOT NULL DEFAULT 12,    -- em quanto tempo ele quer
  comissao_pct  REAL NOT NULL DEFAULT 0,        -- 3 = 3% do que vender
  por_dia       INTEGER NOT NULL DEFAULT 10,    -- ritmo que ELE escolheu
  -- Ticket e conversão saem do histórico dele. Estes campos só existem
  -- para quem ainda não tem histórico e precisa chutar um começo.
  ticket_manual REAL,
  fech_manual   REAL,
  prop_manual   REAL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- Funil: cada pessoa atendida, o que ela quer e onde a conversa parou.
-- Sem isso não existe taxa de conversão própria — só palpite.
CREATE TABLE IF NOT EXISTS atendimentos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id   INTEGER REFERENCES team_members(id),
  customer_id INTEGER REFERENCES customers(id),
  nome        TEXT DEFAULT '',
  instagram   TEXT DEFAULT '',
  canal       TEXT NOT NULL DEFAULT 'direct',        -- direct|whatsapp|loja|site|indicacao
  querendo    TEXT DEFAULT '',                       -- o que a pessoa está comprando
  stage       TEXT NOT NULL DEFAULT 'atendimento',   -- atendimento|proposta|vendido|perdido
  motivo      TEXT DEFAULT '',                       -- por que perdeu
  sale_id     INTEGER,
  valor       REAL NOT NULL DEFAULT 0,               -- valor da proposta
  day         TEXT NOT NULL,                         -- AAAA-MM-DD
  created_at  TEXT NOT NULL,
  updated_at  TEXT
);
-- Carrinho abandonado: quem chegou no checkout, deixou o contato e não
-- terminou. Vem da loja; aqui vira uma venda a resgatar.
CREATE TABLE IF NOT EXISTS carts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ns_checkout_id TEXT UNIQUE,
  customer_id    INTEGER REFERENCES customers(id),
  nome           TEXT DEFAULT '',
  phone          TEXT DEFAULT '',
  email          TEXT DEFAULT '',
  total          REAL NOT NULL DEFAULT 0,
  itens          TEXT DEFAULT '',      -- resumo legível do que ia levar
  url            TEXT DEFAULT '',      -- link que devolve a pessoa ao carrinho
  ns_created_at  TEXT,
  recuperado     INTEGER NOT NULL DEFAULT 0,  -- virou pedido depois
  sale_id        INTEGER,
  created_at     TEXT NOT NULL,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_carts_quando ON carts(ns_created_at);

-- Os modelos de mensagem. O texto é do dono: o sistema só troca as
-- variáveis e põe na fila na hora certa.
CREATE TABLE IF NOT EXISTS msg_templates (
  id           TEXT PRIMARY KEY,      -- carrinho_1 | pedido_pago | ...
  label        TEXT NOT NULL,
  evento       TEXT NOT NULL,         -- carrinho | pago | enviado | retirar | entregue
  corpo        TEXT NOT NULL DEFAULT '',
  ativo        INTEGER NOT NULL DEFAULT 1,
  atraso_horas INTEGER NOT NULL DEFAULT 0,
  ordem        INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT
);

-- A fila: uma linha por mensagem a mandar. "ref" é a chave do evento e
-- é única — é o que garante que ninguém receba a mesma coisa duas vezes.
CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ref            TEXT UNIQUE,
  tipo           TEXT NOT NULL,          -- carrinho | pedido
  template_id    TEXT,
  customer_id    INTEGER,
  cart_id        INTEGER,
  sale_id        INTEGER,
  nome           TEXT DEFAULT '',
  phone          TEXT DEFAULT '',
  corpo          TEXT NOT NULL,          -- já com as variáveis trocadas
  status         TEXT NOT NULL DEFAULT 'pendente', -- pendente|enviado|descartado
  agendado_para  TEXT,
  enviado_em     TEXT,
  enviado_por    INTEGER,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_status ON messages(status, agendado_para);

-- Visão do negócio: quem somos e como a loja gera valor.
-- Textos longos (missão, visão, manifesto) ficam aqui;
-- o que é lista (valores e os nove blocos do Canvas) fica em canvas_items.
CREATE TABLE IF NOT EXISTS canvas_texts (
  chave      TEXT PRIMARY KEY,
  valor      TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS canvas_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bloco      TEXT NOT NULL,
  ordem      INTEGER NOT NULL DEFAULT 0,
  texto      TEXT NOT NULL,
  nota       TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_bloco ON canvas_items(bloco, ordem);

-- O mapa da estratégia: como um estranho vira cliente nesta loja.
-- Cada nível é uma etapa da jornada (descoberta, perfil, conversa…) e
-- cada nó é um caminho dentro dela (anúncio, reels, direct…). O desenho
-- é seu; os números o sistema preenche quando sabe de onde tirar.
CREATE TABLE IF NOT EXISTS funnel_levels (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ordem      INTEGER NOT NULL DEFAULT 0,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS funnel_nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level_id   INTEGER NOT NULL REFERENCES funnel_levels(id) ON DELETE CASCADE,
  ordem      INTEGER NOT NULL DEFAULT 0,
  label      TEXT NOT NULL,
  fonte      TEXT DEFAULT '',   -- '' = você digita | canal:x | etapa:x | venda:x
  valor      REAL,              -- o número, quando não é automático
  meta       REAL,              -- quanto você quer que passe por aqui
  nota       TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fnodes_level ON funnel_nodes(level_id, ordem);

-- CRM: cada conversa com o cliente vira uma linha da história dele.
-- Compra o sistema já sabe; o que faltava era o que foi CONVERSADO.
CREATE TABLE IF NOT EXISTS crm_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  member_id   INTEGER REFERENCES team_members(id),
  kind        TEXT NOT NULL DEFAULT 'nota',  -- nota|direct|whatsapp|ligacao|visita|pos_venda|cobranca
  body        TEXT NOT NULL DEFAULT '',
  motivo      TEXT DEFAULT '',               -- qual régua gerou o contato
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_notes_cli ON crm_notes(customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_atend_dia ON atendimentos(day);
CREATE INDEX IF NOT EXISTS idx_atend_membro ON atendimentos(member_id, day);
CREATE INDEX IF NOT EXISTS idx_atend_stage ON atendimentos(stage);

-- Fechamento de caixa do dia: o que o sistema esperava x o que foi contado.
CREATE TABLE IF NOT EXISTS cash_closings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL UNIQUE,   -- AAAA-MM-DD
  esperado   REAL NOT NULL DEFAULT 0,
  contado    REAL NOT NULL DEFAULT 0,
  diferenca  REAL NOT NULL DEFAULT 0,
  por_forma  TEXT,                   -- JSON com o esperado de cada forma
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

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

// ---- Estoque próprio x sob encomenda ----
// Nem tudo que está à venda no site está aqui na loja: tem produto (e
// tem tamanho) que fica anunciado porque dá para pegar no fornecedor e
// não perder a venda. São dois números por variação:
//   variants.stock   = o que vai para a Nuvemshop (o que está à venda)
//   variants.on_hand = o que existe de verdade aqui (é o que vale)
// products.on_demand marca o modo do produto: 0 = estoque próprio,
// 1 = sob encomenda (aí "em mãos" pode ser menor que o do site).
ensureColumn('products', 'on_demand', 'on_demand INTEGER NOT NULL DEFAULT 0');
ensureColumn('variants', 'on_hand', 'on_hand INTEGER NOT NULL DEFAULT 0');
// Quantas peças da linha saíram por encomenda (não estavam aqui).
ensureColumn('sale_items', 'encomenda', 'encomenda INTEGER NOT NULL DEFAULT 0');

// ---- Despesa a pagar ----
// Uma despesa pode já ter saído do caixa ou estar só agendada. Sem isso
// o "sobrou" do mês contaria dinheiro que ainda não saiu.
ensureColumn('financial_entries', 'paid', 'paid INTEGER NOT NULL DEFAULT 1');
ensureColumn('financial_entries', 'due_date', 'due_date TEXT');
ensureColumn('financial_entries', 'paid_at', 'paid_at TEXT');

// Quem vendeu — sem isso não dá para medir meta de ninguém.
ensureColumn('sales', 'seller_id', 'seller_id INTEGER');
ensureColumn('sales', 'seller_name', 'seller_name TEXT');
// Quanto a pessoa ganha em cima do que vende — é a régua do sonho.
ensureColumn('team_members', 'commission_pct', 'commission_pct REAL NOT NULL DEFAULT 0');
// De qual atendimento essa venda nasceu (fecha o funil).
ensureColumn('sales', 'atendimento_id', 'atendimento_id INTEGER');

// ---- CRM: o que a loja sabe sobre a pessoa ----
// Vender de novo para quem já comprou é o que escala a operação. Para
// isso o sistema precisa lembrar o que a pessoa veste, quando ela some
// e quando é a próxima conversa.
ensureColumn('customers', 'birthday', 'birthday TEXT');          // AAAA-MM-DD ou MM-DD
ensureColumn('customers', 'size_top', 'size_top TEXT');          // camiseta/moletom
ensureColumn('customers', 'size_pants', 'size_pants TEXT');      // calça
ensureColumn('customers', 'size_shoe', 'size_shoe TEXT');        // tênis
ensureColumn('customers', 'tags', 'tags TEXT');                  // livre, separado por vírgula
ensureColumn('customers', 'origin', 'origin TEXT');              // como chegou na loja
ensureColumn('customers', 'owner_id', 'owner_id INTEGER');       // vendedor dono da conta
ensureColumn('customers', 'next_contact', 'next_contact TEXT');  // AAAA-MM-DD do próximo toque
ensureColumn('customers', 'last_contact', 'last_contact TEXT');  // quando falamos por último
ensureColumn('customers', 'no_contact', 'no_contact INTEGER NOT NULL DEFAULT 0'); // pediu para não receber
try { db.exec('CREATE INDEX IF NOT EXISTS idx_customers_next ON customers(next_contact)'); } catch (_) {}
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

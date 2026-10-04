// Cópia de segurança do dia: sai inteira, guarda só as últimas e, se
// configurado, vai para fora do servidor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const pasta = fs.mkdtempSync(join(os.tmpdir(), 'vn-backup-'));
const PASTA_COPIAS = join(pasta, 'copias');
let backup, recebido = null, destino;

before(async () => {
  destino = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => { recebido = { metodo: req.method, url: req.url, bytes: Buffer.concat(partes) }; res.end('ok'); });
  });
  await new Promise((ok) => destino.listen(0, '127.0.0.1', ok));
  // O banco e a pasta são lidos quando o módulo carrega.
  process.env.DB_FILE = join(pasta, 'teste.db');
  process.env.BACKUP_DIR = PASTA_COPIAS;
  process.env.BACKUP_KEEP = '3';
  backup = await import('../server/backup.js');
  const { default: db } = await import('../server/db.js');
  db.prepare("INSERT INTO customers (name, created_at) VALUES ('Cliente da cópia', ?)").run(new Date().toISOString());
});

after(() => {
  destino?.close();
  fs.rmSync(pasta, { recursive: true, force: true });
});

test('a cópia do dia sai inteira e só as últimas ficam', async () => {
  fs.mkdirSync(PASTA_COPIAS, { recursive: true });
  for (const dia of ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04']) {
    fs.writeFileSync(join(PASTA_COPIAS, `vnstore-${dia}.db`), 'velho');
  }
  const r = await backup.backupDoDia();
  assert.equal(r.novo, true);

  const copia = new Database(r.arquivo, { readonly: true });
  assert.equal(copia.prepare('SELECT name FROM customers').get().name, 'Cliente da cópia');
  copia.close();

  const ficaram = fs.readdirSync(PASTA_COPIAS).sort();
  assert.equal(ficaram.length, 3);   // e sem -wal/-shm: a cópia é um arquivo só
  assert.ok(ficaram.includes(r.arquivo.split(/[\\/]/).pop()));
  assert.ok(!ficaram.includes('vnstore-2020-01-01.db'));

  assert.equal((await backup.backupDoDia()).novo, false);   // uma por dia
  assert.ok(backup.situacao().ultimo.bytes > 0);
});

test('com BACKUP_UPLOAD_URL, a cópia também vai para fora', async () => {
  process.env.BACKUP_UPLOAD_URL = `http://127.0.0.1:${destino.address().port}/bucket/o/`;
  const r = await backup.backupDoDia({ forcar: true });
  assert.ok(r.enviado);
  assert.equal(recebido.metodo, 'PUT');
  assert.equal(recebido.url, '/bucket/o/' + r.arquivo.split(/[\\/]/).pop());
  assert.equal(recebido.bytes.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal(backup.situacao().erro, null);
});

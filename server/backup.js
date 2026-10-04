// ============================================================
//  Cópia de segurança do banco.
//
//  Tudo da loja (vendas, caixa, fiado, clientes) mora num arquivo só.
//  Uma vez por dia o sistema tira uma cópia dele e guarda as últimas 14
//  numa pasta fora do sistema (~/vnstore-backups). A cópia é feita pelo
//  próprio SQLite: sai inteira mesmo com venda acontecendo na hora.
//
//  Cópia guardada na mesma máquina não salva de a máquina sumir. Para
//  isso: o botão "Baixar cópia" (tela Conectar) e, se BACKUP_UPLOAD_URL
//  estiver no .env, o envio automático de cada cópia para fora (ex.: um
//  bucket da Oracle com link de escrita).
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import { join, basename } from 'node:path';
import Database from 'better-sqlite3';
import db, { getSetting, setSetting } from './db.js';
import { diaLocal } from './fuso.js';

export const PASTA = process.env.BACKUP_DIR || join(os.homedir(), 'vnstore-backups');
const MANTER = Math.max(1, parseInt(process.env.BACKUP_KEEP, 10) || 14);
const NOME = /^vnstore-\d{4}-\d{2}-\d{2}\.db$/;

const copias = () => (fs.existsSync(PASTA) ? fs.readdirSync(PASTA).filter((f) => NOME.test(f)).sort() : []);

// Cópia do banco agora, no arquivo indicado. Sai como arquivo único
// (sem os -wal/-shm do banco em uso): restaurar é só copiar ele de volta.
export async function copiarBanco(destino) {
  await db.backup(destino);
  const copia = new Database(destino);
  copia.pragma('journal_mode = DELETE');
  copia.close();
  return destino;
}

// A cópia do dia. Se já existe, não faz de novo (a não ser com forcar).
export async function backupDoDia({ forcar = false } = {}) {
  fs.mkdirSync(PASTA, { recursive: true });
  const arquivo = join(PASTA, `vnstore-${diaLocal()}.db`);
  if (!forcar && fs.existsSync(arquivo)) return { arquivo, novo: false };
  try {
    // Grava ao lado e só depois troca o nome: uma cópia pela metade
    // nunca fica com cara de cópia boa.
    const tmp = arquivo + '.tmp';
    await copiarBanco(tmp);
    fs.renameSync(tmp, arquivo);
    for (const velho of copias().reverse().slice(MANTER)) fs.rmSync(join(PASTA, velho), { force: true });

    let enviado = null;
    const url = process.env.BACKUP_UPLOAD_URL;
    if (url) {
      const destino = url.endsWith('/') ? url + basename(arquivo) : url;
      const r = await fetch(destino, { method: 'PUT', body: fs.readFileSync(arquivo), signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`envio para fora falhou (${r.status})`);
      enviado = new Date().toISOString();
    }
    setSetting('last_backup', JSON.stringify({ quando: new Date().toISOString(), arquivo: basename(arquivo), bytes: fs.statSync(arquivo).size, enviado }));
    setSetting('last_backup_error', null);
    return { arquivo, novo: true, enviado };
  } catch (err) {
    setSetting('last_backup_error', `${new Date().toISOString()} · ${err.message}`);
    throw err;
  }
}

export function situacao() {
  let ultimo = null;
  try { ultimo = JSON.parse(getSetting('last_backup') || 'null'); } catch (_) { /* valor antigo */ }
  return {
    ultimo, erro: getSetting('last_backup_error') || null,
    copias: copias().length, manter: MANTER, pasta: PASTA,
    envio_para_fora: Boolean(process.env.BACKUP_UPLOAD_URL),
  };
}

// Confere de hora em hora se a cópia do dia já existe. A primeira do dia
// sai logo depois da meia-noite: é o retrato do fechamento de ontem.
export function agendarBackups() {
  const rodar = () => backupDoDia()
    .then((r) => { if (r.novo) console.log(`› Backup: ${basename(r.arquivo)}${r.enviado ? ' (enviado para fora)' : ''}.`); })
    .catch((err) => console.error('Backup falhou:', err.message));
  setTimeout(rodar, 60 * 1000);
  setInterval(rodar, 60 * 60 * 1000);
}

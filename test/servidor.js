// Sobe o sistema de verdade num processo à parte, com banco e pasta de
// backup temporários, para os testes conversarem com ele por HTTP.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const portaLivre = () => new Promise((ok) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => ok(port)); });
});

export async function subirServidor(env = {}) {
  const pasta = fs.mkdtempSync(join(os.tmpdir(), 'vn-teste-'));
  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;
  let saida = '';
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: RAIZ,
    env: {
      ...process.env,
      PORT: String(porta), DB_FILE: join(pasta, 'teste.db'), BACKUP_DIR: join(pasta, 'backups'),
      APP_PASSWORD: '', SYNC_MINUTES: '60',
      // Sem loja, a não ser que o teste passe uma (modo demonstração).
      NUVEMSHOP_STORE_ID: '', NUVEMSHOP_ACCESS_TOKEN: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => { saida += d; });
  proc.stderr.on('data', (d) => { saida += d; });
  for (let i = 0; ; i += 1) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch (_) { /* ainda subindo */ }
    if (i > 100) { proc.kill(); throw new Error('servidor não subiu:\n' + saida); }
    await new Promise((ok) => setTimeout(ok, 50));
  }

  let banco = null;
  return {
    base, pasta,
    saida: () => saida,
    // Leitura direta do banco, para conferir o que a API não mostra.
    banco: () => (banco ||= new Database(join(pasta, 'teste.db'), { readonly: true })),
    // Pedido HTTP cru: devolve status, cabeçalhos e corpo (JSON quando for).
    async pedir(metodo, caminho, { corpo, headers = {} } = {}) {
      const r = await fetch(base + caminho, {
        method: metodo,
        headers: { ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      const bytes = Buffer.from(await r.arrayBuffer());
      let json = null;
      try { json = JSON.parse(bytes.toString('utf8')); } catch (_) { /* não é JSON */ }
      return { status: r.status, headers: r.headers, bytes, json };
    },
    parar() {
      banco?.close();
      proc.kill();
      fs.rmSync(pasta, { recursive: true, force: true });
    },
  };
}

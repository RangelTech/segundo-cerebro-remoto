// Banco da ponte (SQLite embutido no Node): vínculos, códigos de vínculo, arquivos em trânsito e trilha de auditoria.
// Só guarda hashes de credenciais e metadados; o conteúdo das conversas nunca passa por aqui.
const { DatabaseSync } = require('node:sqlite')
const fs = require('fs')
const path = require('path')

const VERSAO = 3

function abrir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'ponte.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (chave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE IF NOT EXISTS computadores (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL, criado INTEGER NOT NULL, visto INTEGER
    );
    CREATE TABLE IF NOT EXISTS celulares (
      id TEXT PRIMARY KEY, computador_id TEXT NOT NULL REFERENCES computadores(id) ON DELETE CASCADE,
      hash TEXT NOT NULL, nome TEXT NOT NULL, criado INTEGER NOT NULL, ultimo INTEGER
    );
    CREATE INDEX IF NOT EXISTS ix_celulares_pc ON celulares(computador_id);
    CREATE TABLE IF NOT EXISTS codigos (
      codigo TEXT PRIMARY KEY, computador_id TEXT NOT NULL REFERENCES computadores(id) ON DELETE CASCADE, expira INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS arquivos (
      id TEXT PRIMARY KEY, computador_id TEXT NOT NULL REFERENCES computadores(id) ON DELETE CASCADE,
      celular_id TEXT, nome TEXT NOT NULL, tipo TEXT NOT NULL, tamanho INTEGER NOT NULL, criado INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_arquivos_pc ON arquivos(computador_id);
    CREATE TABLE IF NOT EXISTS eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, quando INTEGER NOT NULL, computador_id TEXT, celular_id TEXT, tipo TEXT NOT NULL, detalhe TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_eventos_pc ON eventos(computador_id, id DESC);
  `)
  // v3: placa = código curto e permanente do computador (para vincular o celular digitando)
  if (!db.prepare("PRAGMA table_info(computadores)").all().some((c) => c.name === 'placa')) db.exec('ALTER TABLE computadores ADD COLUMN placa TEXT')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_computadores_placa ON computadores(placa)')
  db.prepare('INSERT OR REPLACE INTO meta(chave, valor) VALUES (?, ?)').run('versao', String(VERSAO))

  const q = {
    computadorNovo: db.prepare('INSERT INTO computadores(id, hash, criado, placa) VALUES (?, ?, ?, ?)'),
    computadorPorPlaca: db.prepare('SELECT * FROM computadores WHERE placa = ?'),
    placaDefinir: db.prepare('UPDATE computadores SET placa = ? WHERE id = ?'),
    semPlaca: db.prepare('SELECT id FROM computadores WHERE placa IS NULL'),
    computador: db.prepare('SELECT * FROM computadores WHERE id = ?'),
    computadorVisto: db.prepare('UPDATE computadores SET visto = ? WHERE id = ?'),
    celularNovo: db.prepare('INSERT INTO celulares(id, computador_id, hash, nome, criado) VALUES (?, ?, ?, ?, ?)'),
    celular: db.prepare('SELECT * FROM celulares WHERE id = ?'),
    celularVisto: db.prepare('UPDATE celulares SET ultimo = ? WHERE id = ?'),
    celularesDe: db.prepare('SELECT id, nome, criado, ultimo FROM celulares WHERE computador_id = ? ORDER BY criado'),
    celularApagar: db.prepare('DELETE FROM celulares WHERE id = ?'),
    codigoLimpar: db.prepare('DELETE FROM codigos WHERE computador_id = ?'),
    codigoNovo: db.prepare('INSERT INTO codigos(codigo, computador_id, expira) VALUES (?, ?, ?)'),
    codigoLer: db.prepare('SELECT * FROM codigos WHERE codigo = ?'),
    codigoApagar: db.prepare('DELETE FROM codigos WHERE codigo = ?'),
    codigosVencidos: db.prepare('DELETE FROM codigos WHERE expira < ?'),
    arquivoNovo: db.prepare('INSERT INTO arquivos(id, computador_id, celular_id, nome, tipo, tamanho, criado) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    arquivo: db.prepare('SELECT * FROM arquivos WHERE id = ?'),
    arquivoApagar: db.prepare('DELETE FROM arquivos WHERE id = ?'),
    arquivosVelhos: db.prepare('SELECT id FROM arquivos WHERE criado < ?'),
    arquivosDe: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tamanho), 0) AS bytes FROM arquivos WHERE computador_id = ?'),
    eventoNovo: db.prepare('INSERT INTO eventos(quando, computador_id, celular_id, tipo, detalhe) VALUES (?, ?, ?, ?, ?)'),
    eventosDe: db.prepare('SELECT id, quando, celular_id, tipo, detalhe FROM eventos WHERE computador_id = ? ORDER BY id DESC LIMIT ?'),
    eventosVelhos: db.prepare('DELETE FROM eventos WHERE quando < ?'),
  }

  return {
    raw: db,
    computadorNovo: (id, hash, placa = null) => q.computadorNovo.run(id, hash, Date.now(), placa),
    computadorPorPlaca: (placa) => q.computadorPorPlaca.get(placa),
    placaDefinir: (id, placa) => q.placaDefinir.run(placa, id),
    semPlaca: () => q.semPlaca.all().map((r) => r.id),
    computador: (id) => q.computador.get(id),
    computadorVisto: (id) => q.computadorVisto.run(Date.now(), id),
    celularNovo: (id, computadorId, hash, nome) => q.celularNovo.run(id, computadorId, hash, nome, Date.now()),
    celular: (id) => q.celular.get(id),
    celularVisto: (id) => q.celularVisto.run(Date.now(), id),
    celularesDe: (computadorId) => q.celularesDe.all(computadorId),
    celularApagar: (id) => q.celularApagar.run(id),
    codigoNovo(codigo, computadorId, expira) {
      q.codigoLimpar.run(computadorId) // um código ativo por computador
      q.codigoNovo.run(codigo, computadorId, expira)
    },
    // consome o código (uso único); devolve o computador se ainda valia
    codigoConsumir(codigo) {
      const c = q.codigoLer.get(codigo)
      q.codigoApagar.run(codigo)
      return c && Date.now() <= c.expira ? c : null
    },
    arquivoNovo: (a) => q.arquivoNovo.run(a.id, a.computadorId, a.celularId, a.nome, a.tipo, a.tamanho, Date.now()),
    arquivo: (id) => q.arquivo.get(id),
    arquivoApagar: (id) => q.arquivoApagar.run(id),
    arquivosDe: (computadorId) => q.arquivosDe.get(computadorId),
    evento: (computadorId, celularId, tipo, detalhe) => q.eventoNovo.run(Date.now(), computadorId || null, celularId || null, tipo, detalhe ? String(detalhe).slice(0, 300) : null),
    eventosDe: (computadorId, n = 50) => q.eventosDe.all(computadorId, n),
    // limpeza: devolve os ids de arquivos vencidos para o servidor apagar do disco
    limpar({ arquivoMs, eventoMs }) {
      const agora = Date.now()
      q.codigosVencidos.run(agora)
      q.eventosVelhos.run(agora - eventoMs)
      const velhos = q.arquivosVelhos.all(agora - arquivoMs).map((a) => a.id)
      for (const id of velhos) q.arquivoApagar.run(id)
      return velhos
    },
    // importa o formato antigo (vinculos.json da v0.1) uma única vez
    migrarJson(arq) {
      if (!fs.existsSync(arq)) return 0
      if (db.prepare('SELECT COUNT(*) AS n FROM computadores').get().n) return 0
      let antigo
      try {
        antigo = JSON.parse(fs.readFileSync(arq, 'utf8'))
      } catch {
        return 0
      }
      let n = 0
      for (const [id, c] of Object.entries(antigo.computadores || {})) (q.computadorNovo.run(id, c.hash, c.criado || Date.now(), null), n++)
      for (const [id, c] of Object.entries(antigo.celulares || {})) if (antigo.computadores?.[c.computadorId]) q.celularNovo.run(id, c.computadorId, c.hash, c.nome || 'Celular', c.criado || Date.now())
      fs.renameSync(arq, arq + '.migrado')
      return n
    },
    fechar: () => db.close(),
  }
}

module.exports = { abrir }

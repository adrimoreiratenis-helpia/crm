const express = require('express');
const Database = require('better-sqlite3');
const { setupNuvemshop, syncProdutoParaNuvemshop, importarProdutosDaNuvemshop, parseJsonArray } = require('./nuvemshop');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const cors = require('cors');

// ─── CLOUDINARY ───────────────────────────────────────────────────────────────
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── MERCADO PAGO ─────────────────────────────────────────────────────────────
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || '',
});

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ─── PASTAS LOCAIS ─────────────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
[DATA_DIR, BACKUP_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

// ─── BANCO ────────────────────────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'shoecrm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS produtos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nome        TEXT    NOT NULL,
    modelo      TEXT    NOT NULL UNIQUE,
    descricao   TEXT,
    preco       REAL    NOT NULL,
    tamanhos    TEXT    NOT NULL DEFAULT '[]',
    cores       TEXT    NOT NULL DEFAULT '[]',
    imagens     TEXT    NOT NULL DEFAULT '[]',
    videos      TEXT    NOT NULL DEFAULT '[]',
    ativo       INTEGER NOT NULL DEFAULT 1,
    ns_id       TEXT,
    criado_em   TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS estoque (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id    INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    tamanho       TEXT    NOT NULL,
    cor           TEXT    NOT NULL,
    quantidade    INTEGER NOT NULL DEFAULT 0,
    atualizado_em TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(produto_id, tamanho, cor)
  );
  CREATE TABLE IF NOT EXISTS vendas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_nome  TEXT    NOT NULL,
    cliente_tel   TEXT    NOT NULL,
    cliente_end   TEXT,
    produto_id    INTEGER REFERENCES produtos(id),
    produto_nome  TEXT,
    tamanho       TEXT,
    cor           TEXT,
    quantidade    INTEGER NOT NULL DEFAULT 1,
    preco_unit    REAL,
    total         REAL,
    pagamento     TEXT,
    status        TEXT    NOT NULL DEFAULT 'pendente',
    observacoes   TEXT,
    criado_em     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS envios (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id       INTEGER NOT NULL UNIQUE REFERENCES vendas(id) ON DELETE CASCADE,
    status         TEXT    NOT NULL DEFAULT 'aguardando',
    rastreio       TEXT,
    transportadora TEXT,
    observacao     TEXT,
    atualizado_em  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS pedidos_online (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    mp_id          TEXT,
    mp_status      TEXT    DEFAULT 'pending',
    cliente_nome   TEXT,
    cliente_email  TEXT,
    cliente_tel    TEXT,
    cliente_end    TEXT,
    itens          TEXT    NOT NULL DEFAULT '[]',
    total          REAL,
    status         TEXT    NOT NULL DEFAULT 'pendente',
    criado_em      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS banners (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo    TEXT,
    subtitulo TEXT,
    url_imagem TEXT,
    url_link  TEXT DEFAULT '#',
    ativo     INTEGER NOT NULL DEFAULT 1,
    ordem     INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// ─── MIGRAÇÕES SEGURAS ────────────────────────────────────────────────────────
// Adiciona colunas novas sem quebrar instâncias já em produção
[
  `ALTER TABLE produtos ADD COLUMN videos TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE produtos ADD COLUMN ns_id TEXT`,
].forEach(sql => { try { db.exec(sql); } catch (_) {} });

// ─── PROTEÇÃO DO ADMIN ────────────────────────────────────────────────────────
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
app.use('/admin.html', (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="AdriMoreira Admin"');
    return res.status(401).send('🔒 Acesso restrito.');
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const pass = decoded.split(':').slice(1).join(':');
  if (pass !== ADMIN_PASS) {
    res.setHeader('WWW-Authenticate', 'Basic realm="AdriMoreira Admin"');
    return res.status(401).send('❌ Senha incorreta.');
  }
  next();
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/loja.html'));

// ─── UPLOAD CLOUDINARY ────────────────────────────────────────────────────────
const imgStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'adrimoreira/produtos', allowed_formats: ['jpg','jpeg','png','webp','gif'], transformation: [{ quality: 'auto', fetch_format: 'auto' }] },
});
const videoStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'adrimoreira/videos', resource_type: 'video', allowed_formats: ['mp4','mov','webm'] },
});
const bannerStorage = new CloudinaryStorage({
  cloudinary,
  params: { folder: 'adrimoreira/banners', allowed_formats: ['jpg','jpeg','png','webp'], transformation: [{ width: 1440, height: 520, crop: 'limit', quality: 'auto' }] },
});

const uploadImg    = multer({ storage: imgStorage,    limits: { fileSize: 5 * 1024 * 1024 } });
const uploadVideo  = multer({ storage: videoStorage,  limits: { fileSize: 80 * 1024 * 1024 } });
const uploadBanner = multer({ storage: bannerStorage, limits: { fileSize: 8 * 1024 * 1024 } });

// ─── Helper: sanitiza listas de tamanhos/cores ────────────────────────────────
// Remove valores vazios, espaços extras e duplicados. Evita o erro
// "Variant values should not be repeated" da Nuvemshop.
function sanitizarLista(lista) {
  return [...new Set(
    (lista || []).map(v => String(v).trim()).filter(Boolean)
  )];
}

// ════════════════════════════════════════════════════════════════════════════
//  PRODUTOS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/produtos', (req, res) => {
  const { ativo, q } = req.query;
  let sql = 'SELECT * FROM produtos WHERE 1=1';
  const params = [];
  if (ativo !== undefined) { sql += ' AND ativo=?'; params.push(Number(ativo)); }
  if (q) { sql += ' AND (nome LIKE ? OR modelo LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY nome';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/produtos/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'Não encontrado' });
});

app.post('/api/produtos', (req, res) => {
  const { nome, modelo, descricao, preco, tamanhos, cores, ativo } = req.body;
  if (!nome || !modelo || preco == null) return res.status(400).json({ error: 'nome, modelo e preco são obrigatórios' });
  try {
    const r = db.prepare(
      'INSERT INTO produtos (nome,modelo,descricao,preco,tamanhos,cores,ativo) VALUES (?,?,?,?,?,?,?)'
    ).run(nome, modelo, descricao || null, preco,
      JSON.stringify(sanitizarLista(tamanhos)),
      JSON.stringify(sanitizarLista(cores)),
      ativo ?? 1);
    res.status(201).json(db.prepare('SELECT * FROM produtos WHERE id=?').get(r.lastInsertRowid));
  } catch (e) { res.status(409).json({ error: e.message }); }
});

app.put('/api/produtos/:id', (req, res) => {
  const { nome, modelo, descricao, preco, tamanhos, cores, ativo } = req.body;
  db.prepare(
    'UPDATE produtos SET nome=?,modelo=?,descricao=?,preco=?,tamanhos=?,cores=?,ativo=? WHERE id=?'
  ).run(nome, modelo, descricao || null, preco,
    JSON.stringify(sanitizarLista(tamanhos)),
    JSON.stringify(sanitizarLista(cores)),
    ativo ?? 1, req.params.id);
  res.json(db.prepare('SELECT * FROM produtos WHERE id=?').get(req.params.id));
});

app.delete('/api/produtos/:id', async (req, res) => {
  const p = db.prepare('SELECT imagens, videos FROM produtos WHERE id=?').get(req.params.id);
  if (p) {
    const allMedia = [...parseJsonArray(p.imagens), ...parseJsonArray(p.videos).map(v => v.url || v).filter(Boolean)];
    for (const url of allMedia) {
      try {
        const publicId = url.split('/').slice(-2).join('/').replace(/\.[^.]+$/, '');
        await cloudinary.uploader.destroy(publicId);
      } catch (_) {}
    }
  }
  db.prepare('DELETE FROM produtos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Upload de imagens → Cloudinary
app.post('/api/produtos/:id/imagens', uploadImg.array('imagens', 8), (req, res) => {
  const p = db.prepare('SELECT imagens FROM produtos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
  const existentes = parseJsonArray(p.imagens);
  const novas = req.files.map(f => f.path);
  const todas = [...existentes, ...novas];
  db.prepare('UPDATE produtos SET imagens=? WHERE id=?').run(JSON.stringify(todas), req.params.id);
  res.json({ imagens: todas });
});

app.delete('/api/produtos/:id/imagens', async (req, res) => {
  const { url } = req.body;
  const p = db.prepare('SELECT imagens FROM produtos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Não encontrado' });
  try {
    const publicId = url.split('/').slice(-2).join('/').replace(/\.[^.]+$/, '');
    await cloudinary.uploader.destroy(publicId);
  } catch (_) {}
  const novas = parseJsonArray(p.imagens).filter(i => i !== url);
  db.prepare('UPDATE produtos SET imagens=? WHERE id=?').run(JSON.stringify(novas), req.params.id);
  res.json({ imagens: novas });
});

// Upload de vídeo → Cloudinary
app.post('/api/produtos/:id/videos', uploadVideo.single('video'), (req, res) => {
  const p = db.prepare('SELECT videos FROM produtos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
  const existentes = parseJsonArray(p.videos);
  const nova = { tipo: 'upload', url: req.file.path };
  const todas = [...existentes, nova];
  db.prepare('UPDATE produtos SET videos=? WHERE id=?').run(JSON.stringify(todas), req.params.id);
  res.json({ videos: todas });
});

// Vídeo embed (YouTube / link)
app.post('/api/produtos/:id/videos/embed', (req, res) => {
  const { url, tipo } = req.body;
  const p = db.prepare('SELECT videos FROM produtos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
  const existentes = parseJsonArray(p.videos);
  const nova = { tipo: tipo || 'youtube', url };
  const todas = [...existentes, nova];
  db.prepare('UPDATE produtos SET videos=? WHERE id=?').run(JSON.stringify(todas), req.params.id);
  res.json({ videos: todas });
});

app.delete('/api/produtos/:id/videos', async (req, res) => {
  const { url } = req.body;
  const p = db.prepare('SELECT videos FROM produtos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Não encontrado' });
  const lista = parseJsonArray(p.videos);
  const item = lista.find(v => v.url === url);
  if (item && item.tipo === 'upload') {
    try {
      const publicId = url.split('/').slice(-2).join('/').replace(/\.[^.]+$/, '');
      await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
    } catch (_) {}
  }
  const novas = lista.filter(v => v.url !== url);
  db.prepare('UPDATE produtos SET videos=? WHERE id=?').run(JSON.stringify(novas), req.params.id);
  res.json({ videos: novas });
});

// ════════════════════════════════════════════════════════════════════════════
//  BANNERS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/banners', (req, res) => {
  const { ativo } = req.query;
  let sql = 'SELECT * FROM banners WHERE 1=1';
  const params = [];
  if (ativo !== undefined) { sql += ' AND ativo=?'; params.push(Number(ativo)); }
  sql += ' ORDER BY ordem, id';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/banners', uploadBanner.single('imagem'), (req, res) => {
  const { titulo, subtitulo, url_link, ativo, ordem } = req.body;
  const url_imagem = req.file ? req.file.path : req.body.url_imagem || null;
  const r = db.prepare(
    'INSERT INTO banners (titulo, subtitulo, url_imagem, url_link, ativo, ordem) VALUES (?,?,?,?,?,?)'
  ).run(titulo || null, subtitulo || null, url_imagem, url_link || '#', ativo ?? 1, ordem || 0);
  res.status(201).json(db.prepare('SELECT * FROM banners WHERE id=?').get(r.lastInsertRowid));
});

app.put('/api/banners/:id', uploadBanner.single('imagem'), (req, res) => {
  const { titulo, subtitulo, url_link, ativo, ordem } = req.body;
  const existing = db.prepare('SELECT * FROM banners WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Banner não encontrado' });
  const url_imagem = req.file ? req.file.path : (req.body.url_imagem || existing.url_imagem);
  db.prepare(
    'UPDATE banners SET titulo=?,subtitulo=?,url_imagem=?,url_link=?,ativo=?,ordem=? WHERE id=?'
  ).run(titulo || null, subtitulo || null, url_imagem, url_link || '#', ativo ?? 1, ordem || 0, req.params.id);
  res.json(db.prepare('SELECT * FROM banners WHERE id=?').get(req.params.id));
});

app.delete('/api/banners/:id', async (req, res) => {
  const b = db.prepare('SELECT url_imagem FROM banners WHERE id=?').get(req.params.id);
  if (b && b.url_imagem) {
    try {
      const publicId = b.url_imagem.split('/').slice(-2).join('/').replace(/\.[^.]+$/, '');
      await cloudinary.uploader.destroy(publicId);
    } catch (_) {}
  }
  db.prepare('DELETE FROM banners WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  ESTOQUE
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/estoque', (req, res) => {
  const { produto_id, q } = req.query;
  let sql = `SELECT e.*, p.nome as produto_nome FROM estoque e LEFT JOIN produtos p ON e.produto_id=p.id WHERE 1=1`;
  const params = [];
  if (produto_id) { sql += ' AND e.produto_id=?'; params.push(produto_id); }
  if (q) { sql += ' AND p.nome LIKE ?'; params.push(`%${q}%`); }
  sql += ' ORDER BY p.nome, e.tamanho, e.cor';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/estoque', (req, res) => {
  const { produto_id, tamanho, cor, quantidade, operacao } = req.body;
  if (!produto_id || !tamanho || !cor) return res.status(400).json({ error: 'produto_id, tamanho e cor obrigatórios' });
  const existing = db.prepare('SELECT * FROM estoque WHERE produto_id=? AND tamanho=? AND cor=?').get(produto_id, tamanho, cor);
  let novaQtd = Number(quantidade) || 0;
  if (existing) {
    if (operacao === 'add') novaQtd = existing.quantidade + novaQtd;
    else if (operacao === 'sub') novaQtd = Math.max(0, existing.quantidade - novaQtd);
    db.prepare("UPDATE estoque SET quantidade=?,atualizado_em=datetime('now','localtime') WHERE produto_id=? AND tamanho=? AND cor=?")
      .run(novaQtd, produto_id, tamanho, cor);
  } else {
    db.prepare('INSERT INTO estoque (produto_id,tamanho,cor,quantidade) VALUES (?,?,?,?)').run(produto_id, tamanho, cor, novaQtd);
  }
  res.json(db.prepare('SELECT * FROM estoque WHERE produto_id=? AND tamanho=? AND cor=?').get(produto_id, tamanho, cor));
});

app.get('/api/estoque/produto/:id', (req, res) => {
  res.json(db.prepare('SELECT tamanho, cor, quantidade FROM estoque WHERE produto_id=? AND quantidade>0').all(req.params.id));
});

// ════════════════════════════════════════════════════════════════════════════
//  VENDAS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/vendas', (req, res) => {
  const { status, q } = req.query;
  let sql = 'SELECT * FROM vendas WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (q) { sql += ' AND (cliente_nome LIKE ? OR cliente_tel LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY id DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/vendas', (req, res) => {
  const { cliente_nome, cliente_tel, cliente_end, produto_id, produto_nome, tamanho, cor, quantidade, preco_unit, total, pagamento, status, observacoes } = req.body;
  if (!cliente_nome || !cliente_tel) return res.status(400).json({ error: 'Nome e telefone obrigatórios' });
  const r = db.prepare(
    'INSERT INTO vendas (cliente_nome,cliente_tel,cliente_end,produto_id,produto_nome,tamanho,cor,quantidade,preco_unit,total,pagamento,status,observacoes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(cliente_nome, cliente_tel, cliente_end || null, produto_id || null, produto_nome || null, tamanho || null, cor || null, quantidade || 1, preco_unit || null, total || null, pagamento || null, status || 'pendente', observacoes || null);
  const vid = r.lastInsertRowid;
  db.prepare('INSERT OR IGNORE INTO envios (venda_id,status) VALUES (?,?)').run(vid, 'aguardando');
  res.status(201).json(db.prepare('SELECT * FROM vendas WHERE id=?').get(vid));
});

app.put('/api/vendas/:id', (req, res) => {
  const { cliente_nome, cliente_tel, cliente_end, produto_id, produto_nome, tamanho, cor, quantidade, preco_unit, total, pagamento, status, observacoes } = req.body;
  db.prepare(
    'UPDATE vendas SET cliente_nome=?,cliente_tel=?,cliente_end=?,produto_id=?,produto_nome=?,tamanho=?,cor=?,quantidade=?,preco_unit=?,total=?,pagamento=?,status=?,observacoes=? WHERE id=?'
  ).run(cliente_nome, cliente_tel, cliente_end || null, produto_id || null, produto_nome || null, tamanho || null, cor || null, quantidade, preco_unit, total, pagamento, status, observacoes || null, req.params.id);
  res.json(db.prepare('SELECT * FROM vendas WHERE id=?').get(req.params.id));
});

app.delete('/api/vendas/:id', (req, res) => {
  db.prepare('DELETE FROM vendas WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  ENVIOS
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/envios', (req, res) => {
  const { status } = req.query;
  let sql = `SELECT e.*, v.cliente_nome, v.cliente_tel, v.produto_nome,
             v.tamanho, v.cor, v.cliente_end, v.total
             FROM envios e LEFT JOIN vendas v ON e.venda_id=v.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND e.status=?'; params.push(status); }
  sql += ' ORDER BY e.id DESC';
  res.json(db.prepare(sql).all(...params));
});

app.put('/api/envios/:venda_id', (req, res) => {
  const { status, rastreio, transportadora, observacao } = req.body;
  const venda_id = req.params.venda_id;
  const anterior = db.prepare('SELECT status FROM envios WHERE venda_id=?').get(venda_id);
  const statusAnterior = anterior ? anterior.status : null;

  db.prepare(`INSERT INTO envios (venda_id,status,rastreio,transportadora,observacao)
              VALUES (?,?,?,?,?)
              ON CONFLICT(venda_id) DO UPDATE SET
              status=excluded.status, rastreio=excluded.rastreio,
              transportadora=excluded.transportadora, observacao=excluded.observacao,
              atualizado_em=datetime('now','localtime')`)
    .run(venda_id, status, rastreio || null, transportadora || null, observacao || null);

  if (status === 'entregue' && statusAnterior !== 'entregue') {
    const venda = db.prepare('SELECT produto_id, tamanho, cor, quantidade FROM vendas WHERE id=?').get(venda_id);
    if (venda && venda.produto_id && venda.tamanho && venda.cor) {
      const item = db.prepare('SELECT id, quantidade FROM estoque WHERE produto_id=? AND tamanho=? AND cor=?').get(venda.produto_id, venda.tamanho, venda.cor);
      if (item) {
        const novaQtd = Math.max(0, item.quantidade - (venda.quantidade || 1));
        db.prepare("UPDATE estoque SET quantidade=?, atualizado_em=datetime('now','localtime') WHERE id=?").run(novaQtd, item.id);
      }
    }
  }
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
//  MERCADO PAGO — CHECKOUT
// ════════════════════════════════════════════════════════════════════════════
app.post('/api/pagamento/criar', async (req, res) => {
  const { itens, cliente } = req.body;
  if (!itens || !itens.length) return res.status(400).json({ error: 'Carrinho vazio' });

  try {
    const r = db.prepare(
      'INSERT INTO pedidos_online (cliente_nome,cliente_email,cliente_tel,cliente_end,itens,total,status) VALUES (?,?,?,?,?,?,?)'
    ).run(
      cliente.nome, cliente.email || null, cliente.tel || null, cliente.endereco || null,
      JSON.stringify(itens),
      itens.reduce((s, i) => s + i.preco * i.quantidade, 0),
      'pendente'
    );
    const pedidoId = r.lastInsertRowid;

    const preference = new Preference(mpClient);
    const result = await preference.create({
      body: {
        items: itens.map(i => ({
          title: i.nome,
          quantity: Number(i.quantidade),
          unit_price: Number(i.preco),
          currency_id: 'BRL',
        })),
        payer: {
          name: cliente.nome,
          email: cliente.email || 'cliente@adrimoreira.com.br',
        },
        back_urls: {
          success: `${BASE_URL}/obrigado.html?pedido=${pedidoId}`,
          failure: `${BASE_URL}/loja.html?erro=pagamento`,
          pending: `${BASE_URL}/obrigado.html?pedido=${pedidoId}&status=pendente`,
        },
        auto_return: 'approved',
        external_reference: String(pedidoId),
        notification_url: `${BASE_URL}/api/pagamento/webhook`,
        statement_descriptor: 'ADRIMOREIRA TENIS',
      },
    });

    db.prepare('UPDATE pedidos_online SET mp_id=? WHERE id=?').run(result.id, pedidoId);

    res.json({
      checkout_url: result.init_point,
      pedido_id: pedidoId,
    });
  } catch (e) {
    console.error('Erro MP:', e);
    res.status(500).json({ error: 'Erro ao criar checkout: ' + e.message });
  }
});

// Webhook do Mercado Pago
app.post('/api/pagamento/webhook', express.json(), async (req, res) => {
  res.sendStatus(200);
  try {
    const { type, data } = req.body;
    if (type === 'payment' && data?.id) {
      const payment = new Payment(mpClient);
      const p = await payment.get({ id: data.id });
      const pedidoId = p.external_reference;
      const status = p.status === 'approved' ? 'pago' : p.status === 'rejected' ? 'cancelado' : 'pendente';
      db.prepare('UPDATE pedidos_online SET mp_status=?,status=? WHERE id=?').run(p.status, status, pedidoId);
      if (p.status === 'approved') {
        const pedido = db.prepare('SELECT * FROM pedidos_online WHERE id=?').get(pedidoId);
        if (pedido) {
          const itens = parseJsonArray(pedido.itens);
          for (const item of itens) {
            const r2 = db.prepare(
              'INSERT INTO vendas (cliente_nome,cliente_tel,cliente_end,produto_id,produto_nome,tamanho,cor,quantidade,preco_unit,total,pagamento,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
            ).run(
              pedido.cliente_nome, pedido.cliente_tel || '', pedido.cliente_end || '',
              item.produto_id || null, item.nome, item.tamanho || null, item.cor || null,
              item.quantidade, item.preco, item.preco * item.quantidade,
              'Mercado Pago', 'pago'
            );
            db.prepare('INSERT OR IGNORE INTO envios (venda_id,status) VALUES (?,?)').run(r2.lastInsertRowid, 'aguardando');
          }
        }
      }
    }
  } catch (e) { console.error('Webhook MP error:', e.message); }
});

// Consultar pedido online
app.get('/api/pedidos-online/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pedidos_online WHERE id=?').get(req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'Não encontrado' });
});

app.get('/api/pedidos-online', (req, res) => {
  res.json(db.prepare('SELECT * FROM pedidos_online ORDER BY id DESC LIMIT 100').all());
});

// ════════════════════════════════════════════════════════════════════════════
//  DASHBOARD
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/dashboard', (req, res) => {
  res.json({
    total_produtos:    db.prepare('SELECT COUNT(*) as c FROM produtos WHERE ativo=1').get().c,
    total_vendas:      db.prepare('SELECT COUNT(*) as c FROM vendas').get().c,
    faturamento:       db.prepare("SELECT COALESCE(SUM(total),0) as t FROM vendas WHERE status='pago'").get().t,
    envios_pendentes:  db.prepare("SELECT COUNT(*) as c FROM envios WHERE status NOT IN ('entregue')").get().c,
    pedidos_online:    db.prepare("SELECT COUNT(*) as c FROM pedidos_online WHERE status='pago'").get().c,
    sincronizados_ns:  db.prepare("SELECT COUNT(*) as c FROM produtos WHERE ns_id IS NOT NULL AND ns_id != ''").get().c,
    vendas_recentes:   db.prepare(`SELECT v.*, e.status as env_status FROM vendas v
                                   LEFT JOIN envios e ON v.id=e.venda_id
                                   ORDER BY v.id DESC LIMIT 8`).all(),
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  BACKUP
// ════════════════════════════════════════════════════════════════════════════
function gerarBackupXlsx(nomeArquivo) {
  const wb = XLSX.utils.book_new();
  const tables = {
    'Produtos':       'SELECT p.*, (SELECT COALESCE(SUM(e.quantidade),0) FROM estoque e WHERE e.produto_id=p.id) as estoque_total FROM produtos p',
    'Estoque':        'SELECT e.*, p.nome as produto_nome FROM estoque e LEFT JOIN produtos p ON e.produto_id=p.id',
    'Vendas':         'SELECT * FROM vendas',
    'Envios':         'SELECT en.*, v.cliente_nome, v.produto_nome FROM envios en LEFT JOIN vendas v ON en.venda_id=v.id',
    'PedidosOnline':  'SELECT * FROM pedidos_online',
    'Banners':        'SELECT * FROM banners',
  };
  Object.entries(tables).forEach(([name, sql]) => {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(db.prepare(sql).all()), name);
  });
  const filePath = path.join(BACKUP_DIR, nomeArquivo);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

function limparBackupsAntigos() {
  const arquivos = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.xlsx'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time);
  arquivos.slice(4).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f.name)));
}

app.get('/api/backup/xlsx', (req, res) => {
  const buf = (() => {
    const wb = XLSX.utils.book_new();
    const tables = {
      'Produtos': 'SELECT p.*, (SELECT COALESCE(SUM(e.quantidade),0) FROM estoque e WHERE e.produto_id=p.id) as estoque_total FROM produtos p',
      'Estoque':  'SELECT e.*, p.nome as produto_nome FROM estoque e LEFT JOIN produtos p ON e.produto_id=p.id',
      'Vendas':   'SELECT * FROM vendas',
      'Envios':   'SELECT en.*, v.cliente_nome, v.produto_nome FROM envios en LEFT JOIN vendas v ON en.venda_id=v.id',
    };
    Object.entries(tables).forEach(([name, sql]) => {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(db.prepare(sql).all()), name);
    });
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  })();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="adrimoreira_export.xlsx"');
  res.send(buf);
});

app.get('/api/backup/db', (req, res) => {
  const dest = path.join(DATA_DIR, `backup_${Date.now()}.db`);
  db.backup(dest).then(() => { res.download(dest, 'adrimoreira.db', () => fs.unlinkSync(dest)); });
});

app.get('/api/backup/sql', (req, res) => {
  const tables = ['produtos', 'estoque', 'vendas', 'envios', 'pedidos_online', 'banners'];
  let sql = `-- AdriMoreira Backup SQL\n-- ${new Date().toLocaleString('pt-BR')}\n\n`;
  tables.forEach(table => {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    rows.forEach(row => {
      const cols = Object.keys(row);
      const vals = cols.map(c => row[c] == null ? 'NULL' : `'${String(row[c]).replace(/'/g, "''")}'`);
      sql += `INSERT INTO ${table} (${cols.join(',')}) VALUES (${vals.join(',')});\n`;
    });
    if (rows.length) sql += '\n';
  });
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="adrimoreira_backup.sql"');
  res.send(sql);
});

// ─── BACKUP AUTOMÁTICO SEMANAL ────────────────────────────────────────────────
function agendarBackupSemanal() {
  const INTERVALO_MS = 7 * 24 * 60 * 60 * 1000;
  function executarBackup() {
    try {
      const nome = `backup_${new Date().toISOString().slice(0, 10)}.xlsx`;
      gerarBackupXlsx(nome);
      limparBackupsAntigos();
      console.log(`✅ Backup automático: ${nome}`);
    } catch (e) { console.error('❌ Backup falhou:', e.message); }
  }
  function msParaProximoDomingo() {
    const agora = new Date();
    const proximo = new Date(agora);
    proximo.setHours(2, 0, 0, 0);
    const dias = (7 - agora.getDay()) % 7 || 7;
    proximo.setDate(agora.getDate() + dias);
    return proximo.getTime() - agora.getTime();
  }
  setTimeout(() => { executarBackup(); setInterval(executarBackup, INTERVALO_MS); }, msParaProximoDomingo());
}
agendarBackupSemanal();

// ─── SEED ─────────────────────────────────────────────────────────────────────
if (db.prepare('SELECT COUNT(*) as c FROM produtos').get().c === 0) {
  const ins    = db.prepare('INSERT INTO produtos (nome,modelo,descricao,preco,tamanhos,cores,ativo) VALUES (?,?,?,?,?,?,?)');
  const insEst = db.prepare('INSERT OR IGNORE INTO estoque (produto_id,tamanho,cor,quantidade) VALUES (?,?,?,?)');
  db.transaction(() => {
    const p1 = ins.run('Tênis Casual Branco', 'TEN-001', 'Tênis leve e confortável para o dia a dia', 189.90, '["36","37","38","39","40","41","42"]', '["Branco","Preto"]', 1);
    const p2 = ins.run('Sandália Rasteira', 'SAN-002', 'Sandália boho em couro sintético', 99.90, '["35","36","37","38","39","40"]', '["Caramelo","Preto","Nude"]', 1);
    const p3 = ins.run('Tênis Chunky', 'TEN-003', 'Solado plataforma tendência', 229.90, '["36","37","38","39","40","41"]', '["Branco","Rosa","Azul"]', 1);
    [[p1.lastInsertRowid,'38','Branco',8],[p1.lastInsertRowid,'39','Preto',5],
     [p2.lastInsertRowid,'37','Caramelo',6],[p2.lastInsertRowid,'38','Nude',4],
     [p3.lastInsertRowid,'38','Branco',7],[p3.lastInsertRowid,'39','Rosa',3]].forEach(a => insEst.run(...a));
  })();
}

// ─── INTEGRAÇÃO NUVEMSHOP ────────────────────────────────────────────────────
setupNuvemshop(app, db);

app.listen(PORT, () => console.log(`✅ AdriMoreira rodando em http://localhost:${PORT}`));

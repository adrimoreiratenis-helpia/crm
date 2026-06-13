// ════════════════════════════════════════════════════════════════════════════
//  INTEGRAÇÃO NUVEMSHOP
//  Adicione este arquivo ao seu projeto e chame setupNuvemshop(app, db)
//  no server.js após a criação do app Express.
// ════════════════════════════════════════════════════════════════════════════

const STORE_ID    = process.env.NS_STORE_ID;
const ACCESS_TOKEN = process.env.NS_ACCESS_TOKEN;
const NS_BASE     = `https://api.tiendanube.com/v1/${STORE_ID}`;
const USER_AGENT  = 'CRM Helpia (helpia49@gmail.com)';

// ─── Helper: chamada autenticada à API da Nuvemshop ──────────────────────────
async function nsRequest(method, endpoint, body = null) {
  const opts = {
    method,
    headers: {
      'Authentication': `bearer ${ACCESS_TOKEN}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${NS_BASE}${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Nuvemshop API ${res.status}: ${err}`);
  }
  return res.json();
}

// ════════════════════════════════════════════════════════════════════════════
//  SINCRONIZAÇÃO DE PRODUTOS: CRM → Nuvemshop
// ════════════════════════════════════════════════════════════════════════════

// Sincroniza um produto do CRM para a Nuvemshop
async function syncProdutoParaNuvemshop(db, produtoId) {
  const produto = db.prepare('SELECT * FROM produtos WHERE id=?').get(produtoId);
  if (!produto) throw new Error('Produto não encontrado');

  const estoque = db.prepare('SELECT * FROM estoque WHERE produto_id=?').all(produtoId);
  const imagens = JSON.parse(produto.imagens || '[]');

  // Monta variantes (tamanho + cor)
  const tamanhos = JSON.parse(produto.tamanhos || '[]');
  const cores    = JSON.parse(produto.cores || '[]');
  const variants = [];

  for (const tam of tamanhos) {
    for (const cor of cores) {
      const estoqueItem = estoque.find(e => e.tamanho === tam && e.cor === cor);
      variants.push({
        price: produto.preco,
        stock_management: true,
        stock: estoqueItem ? estoqueItem.quantidade : 0,
        attributes: [
          { name: 'Tamanho', value: tam },
          { name: 'Cor', value: cor },
        ],
      });
    }
  }

  const payload = {
    name: { pt: produto.nome },
    description: { pt: produto.descricao || '' },
    variants: variants.length ? variants : [{ price: produto.preco, stock: 0 }],
    published: produto.ativo === 1,
  };

  // Verifica se já existe ns_id salvo
  const nsId = produto.ns_id;

  let nsProduct;
  if (nsId) {
    nsProduct = await nsRequest('PUT', `/products/${nsId}`, payload);
  } else {
    nsProduct = await nsRequest('POST', '/products', payload);
    db.prepare('UPDATE produtos SET ns_id=? WHERE id=?').run(nsProduct.id, produtoId);
  }

  // Sincroniza imagens se houver e produto for novo
  if (!nsId && imagens.length) {
    for (const url of imagens) {
      try {
        await nsRequest('POST', `/products/${nsProduct.id}/images`, { src: url });
      } catch (_) {}
    }
  }

  return nsProduct;
}

// Sincroniza estoque de uma variante na Nuvemshop
async function syncEstoqueNuvemshop(db, produtoId, tamanho, cor, quantidade) {
  const produto = db.prepare('SELECT ns_id FROM produtos WHERE id=?').get(produtoId);
  if (!produto?.ns_id) return;

  const variants = await nsRequest('GET', `/products/${produto.ns_id}/variants`);
  const variant = variants.find(v => {
    const attrs = v.values || [];
    return attrs.some(a => a.pt === tamanho || a === tamanho) &&
           attrs.some(a => a.pt === cor || a === cor);
  });
  if (variant) {
    await nsRequest('PUT', `/products/${produto.ns_id}/variants/${variant.id}`, {
      stock: quantidade,
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  SETUP DE ROTAS
// ════════════════════════════════════════════════════════════════════════════
function setupNuvemshop(app, db) {

  // Migração: adiciona coluna ns_id se não existir
  try { db.exec('ALTER TABLE produtos ADD COLUMN ns_id TEXT'); } catch (_) {}

  // ── Webhook: recebe eventos da Nuvemshop ────────────────────────────────
  app.post('/api/nuvemshop/webhook', async (req, res) => {
    res.sendStatus(200); // responde imediatamente
    const { topic, store_id, id } = req.body;
    console.log(`[NS Webhook] ${topic} | store: ${store_id} | id: ${id}`);

    try {
      // ── Novo pedido criado ──────────────────────────────────────────────
      if (topic === 'orders/created' || topic === 'orders/paid') {
        const order = await nsRequest('GET', `/orders/${id}`);
        const cliente = order.contact_name || 'Cliente Nuvemshop';
        const tel     = order.contact_phone || '';
        const end     = [
          order.shipping_address?.address,
          order.shipping_address?.city,
          order.shipping_address?.province,
        ].filter(Boolean).join(', ');

        const itens = (order.products || []).map(p => ({
          produto_id:  null,
          nome:        p.name,
          tamanho:     p.variant_values?.[0] || null,
          cor:         p.variant_values?.[1] || null,
          quantidade:  p.quantity,
          preco:       parseFloat(p.price),
        }));

        // Salva como pedido_online
        const existe = db.prepare('SELECT id FROM pedidos_online WHERE mp_id=?').get(String(id));
        if (!existe) {
          const r = db.prepare(
            'INSERT INTO pedidos_online (mp_id, mp_status, cliente_nome, cliente_tel, cliente_end, itens, total, status) VALUES (?,?,?,?,?,?,?,?)'
          ).run(
            String(id),
            order.payment_status,
            cliente, tel, end,
            JSON.stringify(itens),
            parseFloat(order.total),
            topic === 'orders/paid' ? 'pago' : 'pendente'
          );

          // Se já veio pago, cria venda automaticamente
          if (topic === 'orders/paid') {
            for (const item of itens) {
              const v = db.prepare(
                'INSERT INTO vendas (cliente_nome,cliente_tel,cliente_end,produto_nome,tamanho,cor,quantidade,preco_unit,total,pagamento,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
              ).run(
                cliente, tel, end,
                item.nome, item.tamanho, item.cor,
                item.quantidade, item.preco, item.preco * item.quantidade,
                'Nuvemshop', 'pago'
              );
              db.prepare('INSERT OR IGNORE INTO envios (venda_id,status) VALUES (?,?)').run(v.lastInsertRowid, 'aguardando');
            }
          }
        }
      }

      // ── Pedido pago (evento separado) ───────────────────────────────────
      if (topic === 'orders/fulfilled') {
        const pedido = db.prepare('SELECT * FROM pedidos_online WHERE mp_id=?').get(String(id));
        if (pedido && pedido.status !== 'pago') {
          db.prepare('UPDATE pedidos_online SET status=? WHERE mp_id=?').run('pago', String(id));
          const itens = JSON.parse(pedido.itens || '[]');
          for (const item of itens) {
            const v = db.prepare(
              'INSERT INTO vendas (cliente_nome,cliente_tel,cliente_end,produto_nome,tamanho,cor,quantidade,preco_unit,total,pagamento,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
            ).run(
              pedido.cliente_nome, pedido.cliente_tel, pedido.cliente_end,
              item.nome, item.tamanho, item.cor,
              item.quantidade, item.preco, item.preco * item.quantidade,
              'Nuvemshop', 'pago'
            );
            db.prepare('INSERT OR IGNORE INTO envios (venda_id,status) VALUES (?,?)').run(v.lastInsertRowid, 'aguardando');
          }
        }
      }

      // ── Pedido cancelado ────────────────────────────────────────────────
      if (topic === 'orders/cancelled') {
        db.prepare("UPDATE pedidos_online SET status='cancelado' WHERE mp_id=?").run(String(id));
      }

    } catch (e) {
      console.error('[NS Webhook] Erro:', e.message);
    }
  });

  // ── Sincronizar produto manualmente ────────────────────────────────────
  app.post('/api/nuvemshop/sync/produto/:id', async (req, res) => {
    try {
      const result = await syncProdutoParaNuvemshop(db, req.params.id);
      res.json({ ok: true, ns_id: result.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Sincronizar todos os produtos ───────────────────────────────────────
  app.post('/api/nuvemshop/sync/produtos', async (req, res) => {
    const produtos = db.prepare('SELECT id FROM produtos WHERE ativo=1').all();
    const resultados = [];
    for (const p of produtos) {
      try {
        const r = await syncProdutoParaNuvemshop(db, p.id);
        resultados.push({ id: p.id, ns_id: r.id, ok: true });
      } catch (e) {
        resultados.push({ id: p.id, ok: false, erro: e.message });
      }
    }
    res.json(resultados);
  });

  // ── Buscar pedidos da Nuvemshop ─────────────────────────────────────────
  app.get('/api/nuvemshop/pedidos', async (req, res) => {
    try {
      const orders = await nsRequest('GET', '/orders?per_page=50&status=any');
      res.json(orders);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Registrar webhooks na Nuvemshop ────────────────────────────────────
  app.post('/api/nuvemshop/webhooks/registrar', async (req, res) => {
    const BASE_URL = process.env.BASE_URL;
    const eventos = [
      'orders/created',
      'orders/paid',
      'orders/fulfilled',
      'orders/cancelled',
    ];
    const resultados = [];
    for (const event of eventos) {
      try {
        const r = await nsRequest('POST', '/webhooks', {
          event,
          url: `${BASE_URL}/api/nuvemshop/webhook`,
        });
        resultados.push({ event, ok: true, id: r.id });
      } catch (e) {
        resultados.push({ event, ok: false, erro: e.message });
      }
    }
    res.json(resultados);
  });

  // ── Listar webhooks registrados ─────────────────────────────────────────
  app.get('/api/nuvemshop/webhooks', async (req, res) => {
    try {
      res.json(await nsRequest('GET', '/webhooks'));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  LGPD (obrigatório pela Nuvemshop)
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/nuvemshop/lgpd/store', (req, res) => {
    console.log('[LGPD] store/redact:', req.body);
    res.sendStatus(200);
  });

  app.post('/api/nuvemshop/lgpd/customers', (req, res) => {
    console.log('[LGPD] customers/redact:', req.body);
    res.sendStatus(200);
  });

  app.post('/api/nuvemshop/lgpd/data-request', (req, res) => {
    console.log('[LGPD] customers/data-request:', req.body);
    res.sendStatus(200);
  });

  console.log('✅ Integração Nuvemshop configurada');
}

module.exports = { setupNuvemshop, syncProdutoParaNuvemshop, syncEstoqueNuvemshop };

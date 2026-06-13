// ════════════════════════════════════════════════════════════════════════════
//  INTEGRAÇÃO NUVEMSHOP
// ════════════════════════════════════════════════════════════════════════════

const APP_ID      = process.env.NS_APP_ID      || '34252';
const CLIENT_SECRET = process.env.NS_CLIENT_SECRET;
const USER_AGENT  = 'CRM Helpia (helpia49@gmail.com)';

// Token e Store ID são salvos após OAuth e ficam em memória
// Em produção, salve no banco para sobreviver a reinicializações
let NS_ACCESS_TOKEN = process.env.NS_ACCESS_TOKEN || null;
let NS_STORE_ID     = process.env.NS_STORE_ID     || null;

function getNsBase() {
  return `https://api.tiendanube.com/v1/${NS_STORE_ID}`;
}

// ─── Helper: parse seguro de campos JSON guardados no SQLite ────────────────
// Lida com: array já parseado, string JSON normal, string JSON com escape
// duplo (bug histórico), null/undefined, ou string vazia.
// SEMPRE retorna um array (ou [] em caso de falha).
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  let v = value;
  // Tenta desserializar até 3 vezes (cobre double/triple-encoding antigo)
  for (let i = 0; i < 3; i++) {
    if (typeof v !== 'string') return Array.isArray(v) ? v : [];
    const trimmed = v.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
      v = parsed; // pode ser string novamente (double-encoded) → tenta de novo
    } catch (_) {
      return [];
    }
  }
  return [];
}

// ─── Helper: chamada autenticada à API da Nuvemshop ─────────────────────────
async function nsRequest(method, endpoint, body = null) {
  if (!NS_ACCESS_TOKEN || !NS_STORE_ID) {
    throw new Error('Nuvemshop ainda não autenticada. Instale o app primeiro.');
  }
  const opts = {
    method,
    headers: {
      'Authentication': `bearer ${NS_ACCESS_TOKEN}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${getNsBase()}${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Nuvemshop API ${res.status}: ${err}`);
  }
  return res.json();
}

// ════════════════════════════════════════════════════════════════════════════
//  SINCRONIZAÇÃO DE PRODUTOS: CRM → Nuvemshop
// ════════════════════════════════════════════════════════════════════════════
async function syncProdutoParaNuvemshop(db, produtoId) {
  const produto = db.prepare('SELECT * FROM produtos WHERE id=?').get(produtoId);
  if (!produto) throw new Error('Produto não encontrado');

  const estoque = db.prepare('SELECT * FROM estoque WHERE produto_id=?').all(produtoId);
  const imagens = parseJsonArray(produto.imagens);

  // ─── Remove duplicados e valores vazios de tamanhos/cores ───────────────
  // Evita o erro "Variant values should not be repeated" da Nuvemshop,
  // que ocorre quando o array tem o mesmo valor repetido (ex: ["38","38","39"])
  // ou quando o atributo tem um único valor repetido em todas as variantes.
  const tamanhos = [...new Set(
    parseJsonArray(produto.tamanhos).map(t => String(t).trim()).filter(Boolean)
  )];
  const cores = [...new Set(
    parseJsonArray(produto.cores).map(c => String(c).trim()).filter(Boolean)
  )];

  const variants = [];
  for (const tam of tamanhos) {
    for (const cor of cores) {
      const estoqueItem = estoque.find(e => e.tamanho === tam && e.cor === cor);
      const attributes = [];
      // A Nuvemshop rejeita um atributo cujo valor é idêntico em TODAS as
      // variantes (ex: produto com só 1 cor). Nesse caso, omitimos o atributo.
      if (tamanhos.length > 1) attributes.push({ name: 'Tamanho', value: tam });
      if (cores.length > 1)    attributes.push({ name: 'Cor', value: cor });
      variants.push({
        price: String(produto.preco),
        stock_management: true,
        stock: estoqueItem ? estoqueItem.quantidade : 0,
        ...(attributes.length ? { attributes } : {}),
        values: [
          ...(tamanhos.length > 1 ? [{ pt: tam }] : []),
          ...(cores.length > 1 ? [{ pt: cor }] : []),
        ],
      });
    }
  }

  const payload = {
    name: { pt: produto.nome },
    description: { pt: produto.descricao || '' },
    variants: variants.length ? variants : [{ price: String(produto.preco), stock: 0 }],
    published: produto.ativo === 1,
  };

  const nsId = produto.ns_id;
  let nsProduct;
  if (nsId) {
    nsProduct = await nsRequest('PUT', `/products/${nsId}`, payload);
  } else {
    nsProduct = await nsRequest('POST', '/products', payload);
    db.prepare('UPDATE produtos SET ns_id=? WHERE id=?').run(String(nsProduct.id), produtoId);
  }

  if (!nsId && imagens.length) {
    for (const url of imagens) {
      try {
        await nsRequest('POST', `/products/${nsProduct.id}/images`, { src: url });
      } catch (_) {}
    }
  }
  return nsProduct;
}

// ════════════════════════════════════════════════════════════════════════════
//  SINCRONIZAÇÃO DE PRODUTOS: Nuvemshop → CRM (importação)
// ════════════════════════════════════════════════════════════════════════════
async function importarProdutosDaNuvemshop(db) {
  const resultados = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    const produtosNs = await nsRequest('GET', `/products?per_page=${perPage}&page=${page}`);
    if (!produtosNs.length) break;

    for (const p of produtosNs) {
      try {
        const nome = (p.name && (p.name.pt || p.name.es || p.name.en || Object.values(p.name)[0])) || 'Sem nome';
        const descricao = (p.description && (p.description.pt || p.description.es || p.description.en || Object.values(p.description)[0])) || '';
        const variants = p.variants || [];
        const preco = variants.length ? parseFloat(variants[0].price) || 0 : 0;

        // Extrai tamanhos/cores únicos a partir das variantes
        const tamanhosSet = new Set();
        const coresSet = new Set();
        for (const v of variants) {
          (v.values || []).forEach((val, idx) => {
            const texto = val.pt || val.es || val.en || Object.values(val)[0];
            if (!texto) return;
            // Heurística: primeiro valor = tamanho, segundo = cor
            // (segue a mesma convenção usada no envio CRM → Nuvemshop)
            if (idx === 0) tamanhosSet.add(String(texto).trim());
            else coresSet.add(String(texto).trim());
          });
          (v.attributes || []).forEach(attr => {
            const valor = attr.value || attr.pt || attr.es || attr.en;
            if (!valor) return;
            const nomeAttr = (attr.name || '').toLowerCase();
            if (nomeAttr.includes('tam')) tamanhosSet.add(String(valor).trim());
            else if (nomeAttr.includes('cor') || nomeAttr.includes('color')) coresSet.add(String(valor).trim());
          });
        }

        const tamanhos = [...tamanhosSet];
        const cores = [...coresSet];
        const imagens = (p.images || []).map(img => img.src).filter(Boolean);
        const modelo = `NS-${p.id}`;
        const ns_id = String(p.id);

        // Verifica se já existe pelo ns_id
        const existente = db.prepare('SELECT id FROM produtos WHERE ns_id=?').get(ns_id);

        if (existente) {
          db.prepare(
            'UPDATE produtos SET nome=?,descricao=?,preco=?,tamanhos=?,cores=?,imagens=?,ativo=? WHERE id=?'
          ).run(
            nome, descricao, preco,
            JSON.stringify(tamanhos), JSON.stringify(cores), JSON.stringify(imagens),
            p.published ? 1 : 0, existente.id
          );
          resultados.push({ ns_id, produto_id: existente.id, ok: true, acao: 'atualizado' });
        } else {
          // Garante modelo único (caso já exista um produto com esse código)
          let modeloFinal = modelo;
          let tentativa = 1;
          while (db.prepare('SELECT id FROM produtos WHERE modelo=?').get(modeloFinal)) {
            modeloFinal = `${modelo}-${tentativa++}`;
          }
          const r = db.prepare(
            'INSERT INTO produtos (nome,modelo,descricao,preco,tamanhos,cores,imagens,ativo,ns_id) VALUES (?,?,?,?,?,?,?,?,?)'
          ).run(
            nome, modeloFinal, descricao, preco,
            JSON.stringify(tamanhos), JSON.stringify(cores), JSON.stringify(imagens),
            p.published ? 1 : 0, ns_id
          );
          resultados.push({ ns_id, produto_id: r.lastInsertRowid, ok: true, acao: 'criado' });

          // Importa estoque das variantes
          const novoId = r.lastInsertRowid;
          for (const v of variants) {
            let tam = null, cor = null;
            (v.values || []).forEach((val, idx) => {
              const texto = val.pt || val.es || val.en || Object.values(val)[0];
              if (!texto) return;
              if (idx === 0) tam = String(texto).trim();
              else cor = String(texto).trim();
            });
            if (tam && cor) {
              db.prepare('INSERT OR IGNORE INTO estoque (produto_id,tamanho,cor,quantidade) VALUES (?,?,?,?)')
                .run(novoId, tam, cor, v.stock || 0);
            }
          }
        }
      } catch (e) {
        resultados.push({ ns_id: p.id, ok: false, erro: e.message });
      }
    }

    if (produtosNs.length < perPage) break;
    page++;
    if (page > 20) break; // limite de segurança (1000 produtos)
  }

  return resultados;
}

// ════════════════════════════════════════════════════════════════════════════
//  CORREÇÃO AUTOMÁTICA DE DADOS CORROMPIDOS (double-encoded JSON)
// ════════════════════════════════════════════════════════════════════════════
// Roda na inicialização do servidor. Re-normaliza tamanhos/cores/imagens/videos
// de todos os produtos, garantindo que sejam arrays JSON simples (single-encoded).
function corrigirProdutosCorrompidos(db) {
  const produtos = db.prepare('SELECT id, tamanhos, cores, imagens, videos FROM produtos').all();
  const stmt = db.prepare('UPDATE produtos SET tamanhos=?,cores=?,imagens=?,videos=? WHERE id=?');
  let corrigidos = 0;

  for (const p of produtos) {
    const tamanhos = JSON.stringify([...new Set(parseJsonArray(p.tamanhos).map(v => String(v).trim()).filter(Boolean))]);
    const cores    = JSON.stringify([...new Set(parseJsonArray(p.cores).map(v => String(v).trim()).filter(Boolean))]);
    const imagens  = JSON.stringify(parseJsonArray(p.imagens));
    const videos   = JSON.stringify(parseJsonArray(p.videos));

    if (tamanhos !== p.tamanhos || cores !== p.cores || imagens !== p.imagens || videos !== p.videos) {
      stmt.run(tamanhos, cores, imagens, videos, p.id);
      corrigidos++;
    }
  }

  if (corrigidos > 0) {
    console.log(`🔧 Correção automática: ${corrigidos} produto(s) com dados normalizados.`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  SETUP DE ROTAS
// ════════════════════════════════════════════════════════════════════════════
function setupNuvemshop(app, db) {

  // Migração: adiciona coluna ns_id se não existir
  try { db.exec('ALTER TABLE produtos ADD COLUMN ns_id TEXT'); } catch (_) {}

  // Corrige dados corrompidos de versões anteriores (double-encoded JSON)
  corrigirProdutosCorrompidos(db);

  // ════════════════════════════════════════════════════════════════════════
  //  OAUTH — Recebe o code e troca pelo Access Token
  //  Esta é a URL que deve ser colocada como "Redirect URL" no app
  // ════════════════════════════════════════════════════════════════════════
  app.get('/api/nuvemshop/auth', async (req, res) => {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send('❌ Code não recebido. Reinstale o app pela Nuvemshop.');
    }

    try {
      // Troca o code pelo access_token
      const response = await fetch('https://www.tiendanube.com/apps/authorize/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id:     APP_ID,
          client_secret: CLIENT_SECRET,
          grant_type:    'authorization_code',
          code,
        }),
      });

      const data = await response.json();

      if (!data.access_token) {
        console.error('Erro OAuth Nuvemshop:', data);
        return res.status(500).send('❌ Falha ao obter token: ' + JSON.stringify(data));
      }

      // Salva em memória (e loga para você copiar e salvar no Render)
      NS_ACCESS_TOKEN = data.access_token;
      NS_STORE_ID     = String(data.user_id);

      console.log('✅ Nuvemshop autenticada!');
      console.log('   NS_STORE_ID:    ', NS_STORE_ID);
      console.log('   NS_ACCESS_TOKEN:', NS_ACCESS_TOKEN);

      // Registra webhooks automaticamente
      await registrarWebhooks(process.env.BASE_URL);

      res.send(`
        <html><body style="font-family:sans-serif;padding:40px;text-align:center">
          <h2>✅ CRM Helpia conectado à Nuvemshop!</h2>
          <p><b>Store ID:</b> ${NS_STORE_ID}</p>
          <p><b>Token:</b> ${NS_ACCESS_TOKEN}</p>
          <p style="color:red;font-weight:bold">⚠️ Copie o token acima e salve como variável NS_ACCESS_TOKEN no Render!</p>
          <p>Webhooks registrados automaticamente.</p>
        </body></html>
      `);
    } catch (e) {
      console.error('OAuth error:', e);
      res.status(500).send('❌ Erro: ' + e.message);
    }
  });

  // ── Webhook: recebe eventos da Nuvemshop ─────────────────────────────────
  app.post('/api/nuvemshop/webhook', async (req, res) => {
    res.sendStatus(200);
    const { topic, store_id, id } = req.body;
    console.log(`[NS Webhook] ${topic} | store: ${store_id} | id: ${id}`);

    try {
      // ── Novo pedido / pagamento ──
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
          produto_id: null,
          nome:       p.name,
          tamanho:    p.variant_values?.[0] || null,
          cor:        p.variant_values?.[1] || null,
          quantidade: p.quantity,
          preco:      parseFloat(p.price),
        }));

        const existe = db.prepare('SELECT id FROM pedidos_online WHERE mp_id=?').get(String(id));
        if (!existe) {
          const r = db.prepare(
            'INSERT INTO pedidos_online (mp_id,mp_status,cliente_nome,cliente_tel,cliente_end,itens,total,status) VALUES (?,?,?,?,?,?,?,?)'
          ).run(
            String(id), order.payment_status,
            cliente, tel, end,
            JSON.stringify(itens),
            parseFloat(order.total),
            topic === 'orders/paid' ? 'pago' : 'pendente'
          );

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

      if (topic === 'orders/fulfilled') {
        const pedido = db.prepare('SELECT * FROM pedidos_online WHERE mp_id=?').get(String(id));
        if (pedido && pedido.status !== 'pago') {
          db.prepare("UPDATE pedidos_online SET status='pago' WHERE mp_id=?").run(String(id));
          const itens = parseJsonArray(pedido.itens);
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

      if (topic === 'orders/cancelled') {
        db.prepare("UPDATE pedidos_online SET status='cancelado' WHERE mp_id=?").run(String(id));
      }

      // ── Produto criado/atualizado direto na Nuvemshop → importa para o CRM ──
      if (topic === 'products/created' || topic === 'products/updated') {
        try {
          const p = await nsRequest('GET', `/products/${id}`);
          const nome = (p.name && (p.name.pt || p.name.es || p.name.en || Object.values(p.name)[0])) || 'Sem nome';
          const descricao = (p.description && (p.description.pt || p.description.es || p.description.en || Object.values(p.description)[0])) || '';
          const variants = p.variants || [];
          const preco = variants.length ? parseFloat(variants[0].price) || 0 : 0;

          const tamanhosSet = new Set();
          const coresSet = new Set();
          for (const v of variants) {
            (v.values || []).forEach((val, idx) => {
              const texto = val.pt || val.es || val.en || Object.values(val)[0];
              if (!texto) return;
              if (idx === 0) tamanhosSet.add(String(texto).trim());
              else coresSet.add(String(texto).trim());
            });
          }
          const tamanhos = [...tamanhosSet];
          const cores = [...coresSet];
          const imagens = (p.images || []).map(img => img.src).filter(Boolean);
          const ns_id = String(p.id);

          const existente = db.prepare('SELECT id FROM produtos WHERE ns_id=?').get(ns_id);
          if (existente) {
            db.prepare(
              'UPDATE produtos SET nome=?,descricao=?,preco=?,tamanhos=?,cores=?,imagens=?,ativo=? WHERE id=?'
            ).run(nome, descricao, preco, JSON.stringify(tamanhos), JSON.stringify(cores), JSON.stringify(imagens), p.published ? 1 : 0, existente.id);
          } else {
            const modelo = `NS-${p.id}`;
            let modeloFinal = modelo, tentativa = 1;
            while (db.prepare('SELECT id FROM produtos WHERE modelo=?').get(modeloFinal)) {
              modeloFinal = `${modelo}-${tentativa++}`;
            }
            db.prepare(
              'INSERT INTO produtos (nome,modelo,descricao,preco,tamanhos,cores,imagens,ativo,ns_id) VALUES (?,?,?,?,?,?,?,?,?)'
            ).run(nome, modeloFinal, descricao, preco, JSON.stringify(tamanhos), JSON.stringify(cores), JSON.stringify(imagens), p.published ? 1 : 0, ns_id);
          }
          console.log(`[NS Webhook] Produto ${ns_id} sincronizado do Nuvemshop → CRM`);
        } catch (e) {
          console.error('[NS Webhook] Erro ao importar produto:', e.message);
        }
      }

    } catch (e) {
      console.error('[NS Webhook] Erro:', e.message);
    }
  });

  // ── Sincronizar produto manualmente (CRM → Nuvemshop) ────────────────────
  app.post('/api/nuvemshop/sync/produto/:id', async (req, res) => {
    try {
      const result = await syncProdutoParaNuvemshop(db, req.params.id);
      res.json({ ok: true, ns_id: result.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Sincronizar todos os produtos (CRM → Nuvemshop) ──────────────────────
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

  // ── Importar produtos da Nuvemshop → CRM ─────────────────────────────────
  app.post('/api/nuvemshop/sync/importar', async (req, res) => {
    try {
      const resultados = await importarProdutosDaNuvemshop(db);
      res.json(resultados);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Listar webhooks registrados ──────────────────────────────────────────
  app.get('/api/nuvemshop/webhooks', async (req, res) => {
    try {
      res.json(await nsRequest('GET', '/webhooks'));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Registrar webhooks ────────────────────────────────────────────────────
  app.post('/api/nuvemshop/webhooks/registrar', async (req, res) => {
    try {
      await registrarWebhooks(process.env.BASE_URL);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Buscar pedidos da Nuvemshop ───────────────────────────────────────────
  app.get('/api/nuvemshop/pedidos', async (req, res) => {
    try {
      const orders = await nsRequest('GET', '/orders?per_page=50&status=any');
      res.json(orders);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Status da autenticação ────────────────────────────────────────────────
  app.get('/api/nuvemshop/status', (req, res) => {
    res.json({
      autenticado: !!(NS_ACCESS_TOKEN && NS_STORE_ID),
      store_id: NS_STORE_ID,
      token_presente: !!NS_ACCESS_TOKEN,
    });
  });

  // ── Rota manual de correção de dados (caso precise rodar de novo) ────────
  app.post('/api/nuvemshop/corrigir-dados', (req, res) => {
    try {
      corrigirProdutosCorrompidos(db);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  LGPD (obrigatório pela Nuvemshop)
  // ════════════════════════════════════════════════════════════════════════
  app.post('/api/nuvemshop/lgpd/store',        (req, res) => res.sendStatus(200));
  app.post('/api/nuvemshop/lgpd/customers',     (req, res) => res.sendStatus(200));
  app.post('/api/nuvemshop/lgpd/data-request',  (req, res) => res.sendStatus(200));

  console.log('✅ Integração Nuvemshop configurada');
}

// ─── Registra webhooks na Nuvemshop ─────────────────────────────────────────
async function registrarWebhooks(BASE_URL) {
  const eventos = ['orders/created', 'orders/paid', 'orders/fulfilled', 'orders/cancelled', 'products/created', 'products/updated'];
  for (const event of eventos) {
    try {
      await nsRequest('POST', '/webhooks', {
        event,
        url: `${BASE_URL}/api/nuvemshop/webhook`,
      });
      console.log(`✅ Webhook registrado: ${event}`);
    } catch (e) {
      console.log(`⚠️ Webhook ${event}: ${e.message}`);
    }
  }
}

module.exports = { setupNuvemshop, syncProdutoParaNuvemshop, importarProdutosDaNuvemshop, parseJsonArray };

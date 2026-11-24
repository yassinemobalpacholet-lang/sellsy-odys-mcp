#!/usr/bin/env node
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// === CONFIG ===
const SELLSY_ID = process.env.SELLSY_ID;
const SELLSY_SECRET = process.env.SELLSY_SECRET;
const ODYS_KEY = process.env.ODYS_KEY || 'default-key';
const API_URL = 'https://api.sellsy.com/v2';

if (!SELLSY_ID || !SELLSY_SECRET) {
  console.error('❌ Error: SELLSY_ID and SELLSY_SECRET environment variables are required');
  process.exit(1);
}

// === SELLSY API ===
let cachedToken = null;
let tokenExpires = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && tokenExpires > now) {
    return cachedToken;
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SELLSY_ID,
    client_secret: SELLSY_SECRET,
  });

  const resp = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
    method: 'POST',
    body: params,
  });

  if (!resp.ok) {
    throw new Error(`Failed to get Sellsy token: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpires = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function callSellsy(method, path, body = null) {
  const token = await getToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    opts.body = JSON.stringify(body);
  }

  const resp = await fetch(`${API_URL}${path}`, opts);
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Sellsy API error: ${resp.status} ${errorText.substring(0, 500)}`);
  }

  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

// === HELPERS ===
function normalizeString(s) {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .toUpperCase();
}

function normalizePhone(s) {
  const digits = (s || '').replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) {
    return '+33' + digits.substring(1);
  }
  return digits ? '+' + digits : null;
}

function getTaxId(rate, taxMap, defaultRate = '5.5') {
  try {
    const r = parseFloat(('' + rate).replace(',', '.').replace('%', ''));
    const rateStr = r.toFixed(1);
    return taxMap[rateStr] || taxMap[defaultRate];
  } catch {
    return taxMap[defaultRate];
  }
}

function estSummary(e) {
  const a = e.amounts || {};
  const rel = (e.related || [{}])[0];
  return {
    id: e.id,
    number: e.number,
    status: e.status,
    date: e.date,
    ht: parseFloat(a.total_excl_tax || 0),
    ttc: parseFloat(a.total || 0),
    name: e.company_name || '',
    relType: rel.type,
    relId: rel.id,
    pdf: e.pdf_link,
    public: e.public_link?.enabled ? e.public_link?.url : null,
    subject: e.subject || '',
  };
}

// === MCP TOOLS ===

async function toolCreateEstimate(input) {
  const job = input.job || {};
  const client = job.client || {};

  // Build tax map
  const taxResp = await callSellsy('GET', '/taxes?limit=100');
  const taxMap = {};
  (taxResp.data || []).forEach((t) => {
    if (t.is_active) {
      taxMap[parseFloat(t.rate).toFixed(1)] = t.id;
    }
  });

  // Find or create client
  let clientId, clientType, clientCreated = false;

  if (client.sellsyId) {
    clientId = parseInt(client.sellsyId);
    clientType = client.sellsyType || 'individual';
  } else if (client.societe) {
    // Try to find company
    let found = false;
    if (!client.forceNew) {
      const companies = await callSellsy('POST', '/companies/search?limit=100', { filters: {} });
      const clientKey = normalizeString(client.societe);
      for (const co of companies.data || []) {
        if (normalizeString(co.name) === clientKey) {
          clientId = co.id;
          clientType = 'company';
          found = true;
          break;
        }
      }
    }

    if (!found) {
      const coBody = {
        type: 'prospect',
        name: client.societe,
      };
      if (client.email) coBody.email = client.email;
      if (client.tel) coBody.phone_number = normalizePhone(client.tel);

      const co = await callSellsy('POST', '/companies', coBody);
      clientId = co.id;
      clientType = 'company';
      clientCreated = true;

      if (client.adresse || client.ville) {
        await callSellsy('POST', `/companies/${clientId}/addresses`, {
          name: 'Adresse principale',
          address_line_1: client.adresse || '-',
          postal_code: client.cp || '',
          city: client.ville || '',
          country_code: 'FR',
          is_invoicing_address: true,
          is_delivery_address: true,
        });
      }
    }
  } else {
    // Individual
    if (!client.forceNew && client.email) {
      const indResp = await callSellsy('POST', '/individuals/search?limit=5', {
        filters: { email: client.email },
      });
      if (indResp.data?.length) {
        clientId = indResp.data[0].id;
        clientType = 'individual';
      }
    }

    if (!clientId && !client.forceNew && client.nom) {
      const q = new URLSearchParams({ q: client.nom, limit: 20, 'type[]': 'individual' }).toString();
      const searchResp = await callSellsy('GET', `/search?${q}`);
      const mobPhone = normalizePhone(client.tel);
      for (const h of searchResp.data || []) {
        const o = h.object || {};
        const sameName =
          normalizeString(h.last_name) === normalizeString(client.nom) &&
          (!client.prenom || normalizeString(h.first_name) === normalizeString(client.prenom));
        const sameTel = mobPhone && normalizePhone(h.mobile_number || h.phone_number) === mobPhone;
        if (o.type === 'individual' && sameName && (sameTel || !mobPhone)) {
          clientId = o.id;
          clientType = 'individual';
          break;
        }
      }
    }

    if (!clientId) {
      const indBody = {
        type: 'prospect',
        last_name: client.nom || 'Client',
        civility: (client.civilite || '').startsWith('Mme') ? 'mrs' : 'mr',
      };
      if (client.prenom) indBody.first_name = client.prenom;
      if (client.email) indBody.email = client.email;
      if (client.tel) indBody.mobile_number = normalizePhone(client.tel);

      const ind = await callSellsy('POST', '/individuals', indBody);
      clientId = ind.id;
      clientType = 'individual';
      clientCreated = true;

      if (client.adresse || client.ville) {
        await callSellsy('POST', `/individuals/${clientId}/addresses`, {
          name: 'Adresse principale',
          address_line_1: client.adresse || '-',
          postal_code: client.cp || '',
          city: client.ville || '',
          country_code: 'FR',
          is_invoicing_address: true,
          is_delivery_address: true,
        });
      }
    }
  }

  // Build estimate rows
  const rows = [];
  for (const r of job.rows || []) {
    if (r.type === 'title') {
      rows.push({ type: 'title', text: r.text || '' });
      continue;
    }

    const taxId = getTaxId(r.tva, taxMap, job.tvaDefaut || '5.5');
    const row = {
      quantity: String(r.qte || 1),
      unit_amount: (parseFloat(r.pu) || 0).toFixed(2),
      tax_id: taxId,
    };

    if (r.sellsyId) {
      row.type = 'catalog';
      row.related = { type: 'product', id: parseInt(r.sellsyId) };
    } else {
      row.type = 'single';
      row.reference = (r.ref || '').substring(0, 100) || null;
      row.description = r.nom || '';
    }

    rows.push(Object.fromEntries(Object.entries(row).filter(([, v]) => v != null)));
  }

  // Create estimate
  const estBody = {
    date: job.date || new Date().toISOString().split('T')[0],
    subject: job.subject || '',
    note: job.note || '',
    currency: 'EUR',
    related: [{ type: clientType, id: clientId }],
    rows,
  };

  const est = await callSellsy('POST', '/estimates', estBody);
  const estFull = await callSellsy('GET', `/estimates/${est.id}`);
  const summary = estSummary(estFull);
  summary.clientId = clientId;
  summary.clientType = clientType;
  summary.clientCree = clientCreated;

  return summary;
}

async function toolPing() {
  return { status: 'ok', message: 'Sellsy MCP connector is running' };
}

// === MCP PROTOCOL ===
async function handleMcpRequest(request) {
  const { jsonrpc, id, method, params } = request;

  try {
    let result;

    if (method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'create_estimate',
            description: 'Create an estimate (devis) in Sellsy from Odys data',
            inputSchema: {
              type: 'object',
              properties: {
                job: {
                  type: 'object',
                  description: 'Job data from Odys',
                },
              },
              required: ['job'],
            },
          },
          {
            name: 'ping',
            description: 'Check if the connector is running',
            inputSchema: { type: 'object' },
          },
        ],
      };
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      if (name === 'create_estimate') {
        result = await toolCreateEstimate(args);
      } else if (name === 'ping') {
        result = await toolPing();
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
    } else {
      throw new Error(`Unknown method: ${method}`);
    }

    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: error.message,
      },
    };
  }
}

// === HTTP ROUTES ===

// MCP endpoint (main)
app.post('/mcp/:key', async (req, res) => {
  if (req.params.key !== ODYS_KEY) {
    return res.status(401).json({ error: 'Invalid ODYS_KEY' });
  }

  const result = await handleMcpRequest(req.body);
  res.json(result);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Info
app.get('/', (req, res) => {
  res.json({
    name: 'Sellsy-Odys MCP Connector',
    version: '1.0.0',
    endpoints: {
      mcp: `/mcp/${ODYS_KEY}`,
      health: '/health',
    },
  });
});

// === SERVER ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Sellsy-Odys MCP connector running on port ${PORT}`);
  console.log(`📍 MCP endpoint: http://localhost:${PORT}/mcp/${ODYS_KEY}`);
});

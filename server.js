import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const SELLSY_ID = process.env.SELLSY_ID || '';
const SELLSY_SECRET = process.env.SELLSY_SECRET || '';
const ODYS_KEY = process.env.ODYS_KEY || 'default-key';
const PORT = process.env.PORT || 8080;

console.log(`✅ Sellsy-Odys MCP Server v2.0`);
console.log(`📍 ODYS_KEY: ${ODYS_KEY}`);
console.log(`📍 Sellsy configured: ${SELLSY_ID ? 'YES' : 'NO'}`);

let tokenCache = { access_token: null, expires_at: 0 };

// ============================================
// SELLSY API (Lazy - only when needed)
// ============================================

async function getSellsyToken() {
  if (!SELLSY_ID || !SELLSY_SECRET) {
    throw new Error('SELLSY_ID or SELLSY_SECRET not configured');
  }

  if (tokenCache.access_token && Date.now() < tokenCache.expires_at) {
    return tokenCache.access_token;
  }

  const response = await fetch('https://api.sellsy.com/oauth2/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SELLSY_ID,
      client_secret: SELLSY_SECRET
    })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Sellsy auth failed (${response.status}): ${text.substring(0, 300)}`);
  }

  let data = JSON.parse(text);
  if (!data.access_token) throw new Error('No token in Sellsy response');

  tokenCache = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function callSellsyAPI(method, endpoint, body = null) {
  const token = await getSellsyToken();
  const url = `https://api.sellsy.com/v2${endpoint}`;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Sellsy API error (${response.status}): ${text.substring(0, 300)}`);
  }

  return JSON.parse(text);
}

async function findOrCreateClient(email, name) {
  const searchResponse = await callSellsyAPI('GET', `/contacts?email=${encodeURIComponent(email)}`);
  const contacts = searchResponse.data || searchResponse;

  if (Array.isArray(contacts) && contacts.length > 0) {
    return contacts[0].id;
  }

  const createResponse = await callSellsyAPI('POST', '/contacts', { email, name, type: 'person' });
  return (createResponse.data || createResponse).id;
}

async function createEstimate(clientId, items, subject) {
  const estimateData = {
    contact_id: clientId,
    status: 'draft',
    subject: subject || 'Devis depuis Odys',
    lines: items.map(item => ({
      description: item.description,
      quantity: item.quantity || 1,
      unit_price: item.unit_price || 0,
      tax_rate: item.tax_rate || 0.2
    }))
  };

  const response = await callSellsyAPI('POST', '/estimates', estimateData);
  return response.data || response;
}

// ============================================
// MCP TOOLS
// ============================================

const MCP_TOOLS = [
  {
    name: 'create_estimate',
    description: 'Create estimate in Sellsy',
    inputSchema: {
      type: 'object',
      properties: {
        client_email: { type: 'string' },
        client_name: { type: 'string' },
        items: { type: 'array', items: { type: 'object' } },
        subject: { type: 'string' }
      },
      required: ['client_email', 'client_name', 'items']
    }
  },
  {
    name: 'ping',
    description: 'Test connection',
    inputSchema: { type: 'object' }
  }
];

// ============================================
// MCP MESSAGE HANDLER
// ============================================

async function handleMCPMessage(message) {
  try {
    if (message.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'Sellsy-Odys MCP', version: '2.0.0' }
        }
      };
    }

    if (message.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: MCP_TOOLS }
      };
    }

    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;

      let result;
      if (name === 'create_estimate') {
        const clientId = await findOrCreateClient(args.client_email, args.client_name);
        result = await createEstimate(clientId, args.items, args.subject);
      } else if (name === 'ping') {
        result = { status: 'pong', timestamp: new Date().toISOString() };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }

      return { jsonrpc: '2.0', id: message.id, result };
    }

    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } };
  } catch (error) {
    console.error('MCP Error:', error.message);
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32603, message: error.message }
    };
  }
}

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0' });
});

app.post('/mcp/:key', async (req, res) => {
  if (req.params.key !== ODYS_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const response = await handleMCPMessage(req.body);
  res.json(response);
});

app.get('/', (req, res) => {
  res.json({ name: 'Sellsy-Odys MCP', version: '2.0.0' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on ${PORT}`);
});

import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const SELLSY_ID = process.env.SELLSY_ID || 'default-id';
const SELLSY_SECRET = process.env.SELLSY_SECRET || 'default-secret';
const ODYS_KEY = process.env.ODYS_KEY || 'default-key';
const PORT = process.env.PORT || 8080;

let tokenCache = {
  access_token: null,
  expires_at: 0
};

console.log(`✅ Sellsy-Odys MCP Server Starting...`);
console.log(`📍 Configuration:`);
console.log(`   - SELLSY_ID: ${SELLSY_ID ? SELLSY_ID.substring(0, 8) + '...' : 'NOT SET'}`);
console.log(`   - SELLSY_SECRET: ${SELLSY_SECRET ? 'SET' : 'NOT SET'}`);
console.log(`   - ODYS_KEY: ${ODYS_KEY}`);
console.log(`   - PORT: ${PORT}`);

async function getSellsyToken() {
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at) {
    return tokenCache.access_token;
  }

  const tokenUrl = 'https://api.sellsy.com/oauth2/access_token';
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SELLSY_ID,
      client_secret: SELLSY_SECRET
    })
  });

  if (!response.ok) {
    throw new Error(`Sellsy token error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  tokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000
  };
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
  if (body) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Sellsy API error: ${response.status} - ${errorText}`);
  }
  return await response.json();
}

async function findOrCreateClient(email, name) {
  try {
    const searchResponse = await callSellsyAPI('GET', `/contacts?email=${encodeURIComponent(email)}`);
    if (searchResponse.data && searchResponse.data.length > 0) {
      return searchResponse.data[0].id;
    }
    const createResponse = await callSellsyAPI('POST', '/contacts', {
      email,
      name,
      type: 'person'
    });
    return createResponse.data.id;
  } catch (error) {
    console.error('Client management error:', error);
    throw error;
  }
}

async function createEstimate(clientId, items, subject) {
  try {
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
    return response.data;
  } catch (error) {
    console.error('Estimate creation error:', error);
    throw error;
  }
}

const MCP_TOOLS = [
  {
    name: 'create_estimate',
    description: 'Create an estimate (devis) in Sellsy from an Odys request',
    inputSchema: {
      type: 'object',
      properties: {
        client_email: { type: 'string', description: 'Client email address' },
        client_name: { type: 'string', description: 'Client full name' },
        items: {
          type: 'array',
          description: 'Line items for the estimate',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
              tax_rate: { type: 'number' }
            }
          }
        },
        subject: { type: 'string', description: 'Estimate subject/title' }
      },
      required: ['client_email', 'client_name', 'items']
    }
  },
  {
    name: 'ping',
    description: 'Test endpoint - returns a pong response',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to echo back' }
      }
    }
  }
];

async function handleMCPMessage(message) {
  console.log('📨 MCP Message received:', message.method);

  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'Sellsy-Odys MCP',
          version: '1.0.0'
        }
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
    try {
      let result;
      if (name === 'create_estimate') {
        const clientId = await findOrCreateClient(args.client_email, args.client_name);
        result = await createEstimate(clientId, args.items, args.subject);
      } else if (name === 'ping') {
        result = {
          status: 'pong',
          message: args.message || 'No message provided',
          timestamp: new Date().toISOString()
        };
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return {
        jsonrpc: '2.0',
        id: message.id,
        result
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32603,
          message: error.message
        }
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id: message.id,
    error: {
      code: -32601,
      message: 'Method not found'
    }
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/mcp/:key', async (req, res) => {
  const { key } = req.params;
  if (key !== ODYS_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const message = req.body;
    const response = await handleMCPMessage(message);
    res.json(response);
  } catch (error) {
    console.error('MCP Error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error: ' + error.message
      }
    });
  }
});

app.get('/mcp/info', (req, res) => {
  res.json({
    name: 'Sellsy-Odys MCP',
    version: '1.0.0',
    description: 'MCP server for integrating Sellsy CRM with Odys workflow management',
    tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description }))
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Sellsy-Odys MCP Server',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      mcp_info: 'GET /mcp/info',
      mcp: 'POST /mcp/:key'
    }
  });
});

app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Sellsy-Odys MCP Server running on port ${PORT}`);
  console.log(`📍 MCP Endpoint: http://localhost:${PORT}/mcp/${ODYS_KEY}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📍 Info: http://localhost:${PORT}/mcp/info`);
});

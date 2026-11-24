import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// Configuration
const SELLSY_ID = process.env.SELLSY_ID || 'default-id';
const SELLSY_SECRET = process.env.SELLSY_SECRET || 'default-secret';
const ODYS_KEY = process.env.ODYS_KEY || 'default-key';
const PORT = process.env.PORT || 8080;

// Token cache
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

// ============================================
// SELLSY API FUNCTIONS
// ============================================

async function getSellsyToken() {
  // Check if token is cached and still valid
  if (tokenCache.access_token && Date.now() < tokenCache.expires_at) {
    return tokenCache.access_token;
  }

  const tokenUrl = 'https://api.sellsy.com/oauth2/access_token';

  try {
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

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Sellsy auth failed (${response.status}): ${responseText.substring(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Invalid JSON from Sellsy: ${responseText.substring(0, 200)}`);
    }

    if (!data.access_token) {
      throw new Error(`No access_token in Sellsy response: ${JSON.stringify(data)}`);
    }

    // Cache the token with 1 hour expiry
    tokenCache = {
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000
    };

    return data.access_token;
  } catch (error) {
    console.error('❌ Sellsy Token Error:', error.message);
    throw error;
  }
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

  try {
    const response = await fetch(url, options);
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(`Sellsy API error (${response.status}): ${responseText.substring(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Invalid JSON from Sellsy API: ${responseText.substring(0, 200)}`);
    }

    return data;
  } catch (error) {
    console.error('❌ Sellsy API Error:', error.message);
    throw error;
  }
}

async function findOrCreateClient(email, name) {
  try {
    // Search for existing client
    const searchResponse = await callSellsyAPI('GET', `/contacts?email=${encodeURIComponent(email)}`);

    // Handle different response formats
    const contacts = searchResponse.data || searchResponse;
    if (Array.isArray(contacts) && contacts.length > 0) {
      return contacts[0].id;
    }

    // Create new client if not found
    const createResponse = await callSellsyAPI('POST', '/contacts', {
      email,
      name,
      type: 'person'
    });

    // Handle different response formats
    const newContact = createResponse.data || createResponse;
    return newContact.id;
  } catch (error) {
    console.error('❌ Client management error:', error.message);
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

    // Handle different response formats
    const estimate = response.data || response;
    return estimate;
  } catch (error) {
    console.error('❌ Estimate creation error:', error.message);
    throw error;
  }
}

// ============================================
// MCP PROTOCOL IMPLEMENTATION
// ============================================

// MCP Tool definitions
const MCP_TOOLS = [
  {
    name: 'create_estimate',
    description: 'Create an estimate (devis) in Sellsy from an Odys request',
    inputSchema: {
      type: 'object',
      properties: {
        client_email: {
          type: 'string',
          description: 'Client email address'
        },
        client_name: {
          type: 'string',
          description: 'Client full name'
        },
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
        subject: {
          type: 'string',
          description: 'Estimate subject/title'
        }
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
        message: {
          type: 'string',
          description: 'Message to echo back'
        }
      }
    }
  }
];

// MCP Message handler
async function handleMCPMessage(message) {
  console.log('📨 MCP Message received:', message.method);

  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'Sellsy-Odys MCP',
          version: '1.0.1'
        }
      }
    };
  }

  if (message.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: MCP_TOOLS
      }
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
      console.error('❌ Tool Error:', error.message);
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

// ============================================
// EXPRESS ROUTES
// ============================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// MCP endpoint
app.post('/mcp/:key', async (req, res) => {
  const { key } = req.params;

  // Verify API key
  if (key !== ODYS_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const message = req.body;
    const response = await handleMCPMessage(message);
    res.json(response);
  } catch (error) {
    console.error('❌ MCP Error:', error.message);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error: ' + error.message
      }
    });
  }
});

// MCP info endpoint
app.get('/mcp/info', (req, res) => {
  res.json({
    name: 'Sellsy-Odys MCP',
    version: '1.0.1',
    description: 'MCP server for integrating Sellsy CRM with Odys workflow management',
    tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description }))
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Sellsy-Odys MCP Server',
    version: '1.0.1',
    endpoints: {
      health: 'GET /health',
      mcp_info: 'GET /mcp/info',
      mcp: 'POST /mcp/:key'
    }
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('❌ Express Error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Sellsy-Odys MCP Server running on port ${PORT}`);
  console.log(`📍 MCP Endpoint: http://localhost:${PORT}/mcp/${ODYS_KEY}`);
  console.log(`📍 Health: http://localhost:${PORT}/health`);
  console.log(`📍 Info: http://localhost:${PORT}/mcp/info`);
});

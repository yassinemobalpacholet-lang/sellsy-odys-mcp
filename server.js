import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;

const SELLSY_ID = process.env.SELLSY_ID || 'default-id';
const SELLSY_SECRET = process.env.SELLSY_SECRET || 'default-secret';
const ODYS_KEY = process.env.ODYS_KEY || 'default-key';

let tokenCache = {
  access_token: null,
  expires_at: 0
};

// Logging helper
function log(message, data = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, data);
}

app.use(express.json());

// MCP Protocol Implementation
const tools = [
  {
    name: 'create_estimate',
    description: 'Create an estimate (devis) in Sellsy CRM',
    inputSchema: {
      type: 'object',
      properties: {
        client_email: { type: 'string', description: 'Email of the client' },
        client_name: { type: 'string', description: 'Name of the client' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number', description: 'Prix unitaire HT' },
              tax_rate: { type: 'number', description: 'Taux de TVA en % (ex. 5.5, 10, 20). Défaut : DEFAULT_TAX_RATE ou 20' },
              reference: { type: 'string', description: 'Référence article (optionnel)' }
            }
          },
          description: 'Line items for the estimate'
        },
        subject: { type: 'string', description: 'Subject/title of the estimate' }
      },
      required: ['client_email', 'client_name', 'items', 'subject']
    }
  },
  {
    name: 'ping',
    description: 'Test connection to Sellsy'
  }
];

// Get Sellsy OAuth2 Token
async function getSellsyToken() {
  log('Checking token cache...');

  if (tokenCache.access_token && Date.now() < tokenCache.expires_at) {
    log('Using cached token, expires in', Math.round((tokenCache.expires_at - Date.now()) / 1000) + 's');
    return tokenCache.access_token;
  }

  log('Requesting new token from Sellsy OAuth2');
  log('Using credentials:', `ID=${SELLSY_ID.substring(0, 8)}...`);

  const tokenUrl = 'https://login.sellsy.com/oauth2/access-tokens';

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
      }).toString()
    });

    log('Token response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      log('Token error response:', errorText.substring(0, 500));
      throw new Error(`Sellsy token error: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    log('Token obtained successfully, expires in', data.expires_in + 's');

    tokenCache = {
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000
    };

    return data.access_token;
  } catch (error) {
    log('ERROR in getSellsyToken:', error.message);
    throw error;
  }
}

// Call Sellsy API
async function callSellsyAPI(method, endpoint, data = null) {
  log(`Calling Sellsy API: ${method} ${endpoint}`);

  const token = await getSellsyToken();

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  if (data) {
    options.body = JSON.stringify(data);
  }

  const response = await fetch(`https://api.sellsy.com/v2${endpoint}`, options);

  if (!response.ok) {
    const errorText = await response.text();
    log(`API error ${response.status}:`, errorText.substring(0, 500));
    throw new Error(`Sellsy API error: ${response.status} - ${errorText.substring(0, 200)}`);
  }

  return await response.json();
}

// Sellsy V2 : les créations renvoient l'objet directement, les listes/recherches renvoient { data: [...] }
function unwrap(res) {
  return res && res.data && !Array.isArray(res.data) ? res.data : res;
}

// Find or Create Client (particulier = "individual" dans Sellsy V2)
async function findOrCreateClient(email, name) {
  log('Looking for client:', email);

  try {
    // Recherche d'un particulier existant par email
    try {
      const search = await callSellsyAPI('POST', '/individuals/search?limit=10', {
        filters: { email }
      });
      const match = (search.data || []).find(
        ind => (ind.email || '').toLowerCase() === email.toLowerCase()
      );
      if (match) {
        log('Found existing client:', match.id);
        return match.id;
      }
    } catch (searchError) {
      log('Client search failed, will create a new one:', searchError.message);
    }

    log('Creating new client:', name);
    const parts = name.trim().split(/\s+/);
    const created = unwrap(await callSellsyAPI('POST', '/individuals', {
      type: 'client',
      first_name: parts.length > 1 ? parts[0] : '',
      last_name: parts.length > 1 ? parts.slice(1).join(' ') : name,
      email
    }));

    log('Client created with ID:', created.id);
    return created.id;
  } catch (error) {
    log('ERROR in findOrCreateClient:', error.message);
    throw error;
  }
}

// Taux de TVA -> tax_id Sellsy (obligatoire sur chaque ligne)
let taxesCache = null;
async function getTaxId(rate) {
  if (!taxesCache) {
    const res = await callSellsyAPI('GET', '/taxes?limit=100');
    taxesCache = res.data || [];
  }
  const tax = taxesCache.find(t => Number(t.rate) === Number(rate) && t.is_active !== false);
  if (!tax) {
    const available = taxesCache.map(t => t.rate).join(', ');
    throw new Error(`No Sellsy tax found for rate ${rate}% (available: ${available})`);
  }
  return tax.id;
}

const DEFAULT_TAX_RATE = Number(process.env.DEFAULT_TAX_RATE || 20);

// Create Estimate (format Sellsy API V2)
async function createEstimate(clientId, subject, items) {
  log('Creating estimate for client:', clientId);

  try {
    const rows = [];
    for (const item of items) {
      rows.push({
        type: 'single',
        reference: item.reference || undefined,
        description: item.description || 'Article',
        quantity: String(item.quantity ?? 1),
        unit_amount: Number(item.unit_price ?? 0).toFixed(2),
        tax_id: await getTaxId(item.tax_rate ?? DEFAULT_TAX_RATE)
      });
    }

    const estimateData = {
      date: new Date().toISOString().slice(0, 10),
      subject,
      currency: 'EUR',
      related: [{ id: clientId, type: 'individual' }],
      rows
    };

    log('Estimate data to send:', JSON.stringify(estimateData));
    const estimate = unwrap(await callSellsyAPI('POST', '/estimates', estimateData));
    log('Estimate created with ID:', estimate.id);
    return estimate;
  } catch (error) {
    log('ERROR in createEstimate:', error.message);
    throw error;
  }
}

// MCP Message Handler
async function handleMCPMessage(message) {
  log('Handling MCP message:', message.method);

  const { method, params } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'Sellsy-Odys-MCP',
          version: '1.0.0'
        }
      },
      id: message.id
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      result: { tools },
      id: message.id
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    log('Calling tool:', name);
    log('Tool arguments:', JSON.stringify(args));

    if (name === 'ping') {
      return {
        jsonrpc: '2.0',
        result: {
          content: [
            {
              type: 'text',
              text: 'Sellsy-Odys-MCP server is running!'
            }
          ]
        },
        id: message.id
      };
    }

    if (name === 'create_estimate') {
      try {
        // Support both Odys structure and direct structure
        let client_email, client_name, items, subject;

        // Check if args has job structure (Odys format)
        if (args.job && args.job.client) {
          const jobClient = args.job.client;
          const jobRows = args.job.rows || [];

          client_email = jobClient.email;
          client_name = `${jobClient.prenom} ${jobClient.nom}`;
          subject = jobClient.subject || `Devis ${jobClient.nom}`;

          // Map rows to items (rows can be at job.rows or job.client.rows)
          items = jobRows.map(row => ({
            description: row.nom || row.name || 'Article',
            quantity: parseInt(row.qte) || row.quantity || 1,
            unit_price: parseFloat(row.pu) || row.unit_price || 0,
            tax_rate: row.tva ?? row.tax_rate,
            reference: row.ref || row.reference
          }));
        } else {
          // Direct parameter structure
          ({ client_email, client_name, items, subject } = args || {});
        }

        // Validation des paramètres requis
        if (!client_email) {
          throw new Error('Missing required parameter: client_email');
        }
        if (!client_name) {
          throw new Error('Missing required parameter: client_name');
        }
        if (!items || !Array.isArray(items) || items.length === 0) {
          throw new Error('Missing or invalid parameter: items (must be non-empty array)');
        }
        if (!subject) {
          throw new Error('Missing required parameter: subject');
        }

        log('create_estimate parameters valid:', { client_email, client_name, itemCount: items.length, subject });

        const clientId = await findOrCreateClient(client_email, client_name);
        const estimate = await createEstimate(clientId, subject, items);

        return {
          jsonrpc: '2.0',
          result: {
            content: [
              {
                type: 'text',
                text: `Estimate created successfully! ID: ${estimate.id}`
              }
            ]
          },
          id: message.id
        };
      } catch (error) {
        log('ERROR in create_estimate tool:', error.message);
        return {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `Error creating estimate: ${error.message}`
          },
          id: message.id
        };
      }
    }

    return {
      jsonrpc: '2.0',
      error: {
        code: -32602,
        message: `Unknown tool: ${name}`
      },
      id: message.id
    };
  }

  return {
    jsonrpc: '2.0',
    error: {
      code: -32601,
      message: 'Method not found'
    },
    id: message.id
  };
}

// Routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/mcp/:key', async (req, res) => {
  const { key } = req.params;

  if (key !== ODYS_KEY) {
    log('Unauthorized MCP request with invalid key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await handleMCPMessage(req.body);
    res.json(result);
  } catch (error) {
    log('ERROR in /mcp handler:', error.message);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error.message
      },
      id: req.body.id
    });
  }
});

app.get('/mcp/info', (req, res) => {
  res.json({
    service: 'Sellsy-Odys-MCP',
    version: '1.0.0',
    status: 'active'
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Sellsy-Odys-MCP',
    version: '1.0.0',
    endpoints: [
      'GET /health - Health check',
      'POST /mcp/:key - MCP protocol',
      'GET /mcp/info - Service info'
    ]
  });
});

// Start Server
app.listen(PORT, () => {
  log('='.repeat(60));
  log('Sellsy-Odys-MCP Server Started');
  log('='.repeat(60));
  log('Port:', PORT);
  log('Service URL:', `http://localhost:${PORT}`);
  log('MCP Key configured:', ODYS_KEY ? 'YES' : 'NO');
  log('Sellsy ID configured:', SELLSY_ID !== 'default-id' ? 'YES' : 'NO');
  log('Sellsy Secret configured:', SELLSY_SECRET !== 'default-secret' ? 'YES' : 'NO');
  log('OAuth2 Endpoint:', 'https://login.sellsy.com/oauth2/access-tokens');
  log('='.repeat(60));
});

export default app;

import express from 'express';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const ODYS_KEY = process.env.ODYS_KEY || 'esk123456789';

console.log(`✅ Server starting on port ${PORT}`);
console.log(`🔑 ODYS_KEY: ${ODYS_KEY}`);

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// MCP endpoint
app.post('/mcp/:key', (req, res) => {
  if (req.params.key !== ODYS_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { method } = req.body;

  // Handle MCP protocol
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id: req.body.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'Sellsy-Odys MCP', version: '1.0.0' }
      }
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id: req.body.id,
      result: {
        tools: [
          {
            name: 'ping',
            description: 'Test connectivity',
            inputSchema: { type: 'object', properties: {} }
          }
        ]
      }
    });
  }

  if (method === 'tools/call') {
    return res.json({
      jsonrpc: '2.0',
      id: req.body.id,
      result: { status: 'pong' }
    });
  }

  res.json({
    jsonrpc: '2.0',
    id: req.body.id,
    error: { code: -32601, message: 'Method not found' }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ MCP Server listening on port ${PORT}`);
});

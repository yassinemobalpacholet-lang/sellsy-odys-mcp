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

function log(message, data = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, data);
}

app.use(express.json());

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
              unit_price: { type: 'number' }
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

// Main entry point - simplified for Railway
import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import postgres from 'postgres';

// ============================================
// CONFIGURATION
// ============================================
const PORT = parseInt(process.env.PORT || '3000');
const DATABASE_URL = process.env.DATABASE_URL || '';
const FACTORY_ADDRESS = '0x70b17db500Ce1746BB34f908140d0279C183f3eb';

console.log('🚀 cc0strategy Indexer Starting...');
console.log(`🌐 Port: ${PORT}`);
console.log(`📦 Database: ${DATABASE_URL ? 'configured' : 'NOT SET'}`);

// ============================================
// DATABASE
// ============================================
let sql: ReturnType<typeof postgres> | null = null;

if (DATABASE_URL) {
  try {
    sql = postgres(DATABASE_URL, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 30,
    });
    console.log('✅ Database configured');
  } catch (e: any) {
    console.error('❌ Database connection error:', e.message);
  }
}

// ============================================
// API SERVER
// ============================================
const app = new Hono();

app.use('*', cors());

// Health check
app.get('/', (c) => c.json({ 
  status: 'ok', 
  service: 'cc0strategy-indexer', 
  factory: FACTORY_ADDRESS,
  database: sql ? 'connected' : 'not connected',
  timestamp: new Date().toISOString()
}));

app.get('/health', (c) => c.json({ 
  status: 'healthy', 
  timestamp: new Date().toISOString() 
}));

// GET /tokens - List all tokens
app.get('/tokens', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured', tokens: [] }, 500);
  }
  
  try {
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = parseInt(c.req.query('offset') || '0');
    
    const tokens = await sql`
      SELECT * FROM tokens 
      ORDER BY deployed_at DESC 
      LIMIT ${limit} OFFSET ${offset}
    `;
    
    return c.json({ tokens, pagination: { limit, offset } });
  } catch (e: any) {
    console.error('Error fetching tokens:', e.message);
    return c.json({ error: e.message, tokens: [] }, 500);
  }
});

// GET /tokens/:address - Single token
app.get('/tokens/:address', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured' }, 500);
  }
  
  try {
    const address = c.req.param('address').toLowerCase();
    const result = await sql`SELECT * FROM tokens WHERE address = ${address}`;
    
    if (!result[0]) {
      return c.json({ error: 'Token not found' }, 404);
    }
    
    return c.json(result[0]);
  } catch (e: any) {
    console.error('Error fetching token:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// POST /tokens - Register new token
app.post('/tokens', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured' }, 500);
  }
  
  try {
    const body = await c.req.json();
    const {
      address,
      name,
      symbol,
      decimals = 18,
      nft_collection,
      deployer,
      deploy_tx_hash,
      deploy_block = 0,
      deployed_at,
      image_url,
      description,
      pool_id,
      chain = 'base',
    } = body;
    
    // Validate required fields
    if (!address || !name || !symbol || !nft_collection || !deployer || !deploy_tx_hash) {
      return c.json({ error: 'Missing required fields' }, 400);
    }
    
    // Insert token
    const result = await sql`
      INSERT INTO tokens (
        address, name, symbol, decimals, nft_collection, deployer,
        deploy_tx_hash, deploy_block, deployed_at, image_url, description, pool_id, chain
      ) VALUES (
        ${address.toLowerCase()}, ${name}, ${symbol}, ${decimals}, ${nft_collection.toLowerCase()},
        ${deployer.toLowerCase()}, ${deploy_tx_hash}, ${deploy_block},
        ${deployed_at || new Date().toISOString()}, ${image_url || null}, ${description || null},
        ${pool_id ? Buffer.from(pool_id.slice(2), 'hex') : null}, ${chain}
      )
      ON CONFLICT (address) DO UPDATE SET
        name = EXCLUDED.name,
        symbol = EXCLUDED.symbol,
        image_url = COALESCE(EXCLUDED.image_url, tokens.image_url),
        description = COALESCE(EXCLUDED.description, tokens.description),
        updated_at = NOW()
      RETURNING *
    `;
    
    console.log(`✅ Token registered: ${symbol} (${address})`);
    return c.json(result[0]);
  } catch (e: any) {
    console.error('Error registering token:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// GET /stats
app.get('/stats', async (c) => {
  if (!sql) {
    return c.json({ total_tokens: 0 });
  }
  
  try {
    const [stats] = await sql`SELECT COUNT(*) as total_tokens FROM tokens`;
    return c.json(stats);
  } catch (e: any) {
    return c.json({ total_tokens: 0, error: e.message });
  }
});

// ============================================
// START SERVER
// ============================================
console.log(`🚀 Starting server on port ${PORT}...`);

serve({ 
  fetch: app.fetch, 
  port: PORT 
}, (info) => {
  console.log(`✅ Server listening on http://localhost:${info.port}`);
});

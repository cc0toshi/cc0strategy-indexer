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

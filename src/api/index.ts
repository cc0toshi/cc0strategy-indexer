import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import 'dotenv/config';
import { getTokens, getTokenByAddress, getSwapsForToken, getOHLCV, sql } from '../db/index.js';

const app = new Hono();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'cc0strategy-indexer' }));
app.get('/health', (c) => c.json({ status: 'healthy' }));

// GET /tokens - List all tokens
app.get('/tokens', async (c) => {
  const sortBy = c.req.query('sort') as 'deployed_at' | 'volume_24h' | 'tvl' || 'deployed_at';
  const order = c.req.query('order') as 'asc' | 'desc' || 'desc';
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const tokens = await getTokens({ sortBy, order, limit, offset });
  return c.json({ tokens, pagination: { limit, offset } });
});

// GET /tokens/:address - Token details
app.get('/tokens/:address', async (c) => {
  const address = c.req.param('address');
  const token = await getTokenByAddress(address);
  if (!token) return c.json({ error: 'Token not found' }, 404);
  return c.json(token);
});

// GET /tokens/:address/swaps - Recent trades
app.get('/tokens/:address/swaps', async (c) => {
  const address = c.req.param('address');
  const limit = parseInt(c.req.query('limit') || '50');
  const swaps = await getSwapsForToken(address, limit);
  return c.json({ swaps });
});

// GET /tokens/:address/chart - OHLCV data
app.get('/tokens/:address/chart', async (c) => {
  const address = c.req.param('address');
  const interval = c.req.query('interval') || '1h';
  const limit = parseInt(c.req.query('limit') || '100');
  const candles = await getOHLCV(address, interval, limit);
  return c.json({ candles: candles.reverse() }); // oldest first for charts
});

// GET /rewards/:wallet - Pending rewards for wallet's NFTs
app.get('/rewards/:wallet', async (c) => {
  const wallet = c.req.param('wallet').toLowerCase();
  
  // This requires integrating with NFT ownership data
  // For now, return structure. Need to query NFT contracts.
  const rewards = await sql`
    SELECT t.address as token_address, t.symbol, t.nft_collection,
           ts.pending_fees
    FROM tokens t
    JOIN token_stats ts ON t.address = ts.token_address
    WHERE ts.pending_fees != '0'
  `;
  
  return c.json({
    wallet,
    rewards,
    note: 'Full implementation requires NFT ownership check'
  });
});

// GET /stats - Global stats
app.get('/stats', async (c) => {
  const [stats] = await sql`
    SELECT 
      COUNT(*) as total_tokens,
      COALESCE(SUM(ts.volume_24h::numeric), 0) as total_volume_24h,
      COALESCE(SUM(ts.total_fees_distributed::numeric), 0) as total_fees
    FROM tokens t
    LEFT JOIN token_stats ts ON t.address = ts.token_address
  `;
  return c.json(stats);
});

const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 API server starting on port ${port}`);

serve({ fetch: app.fetch, port });

export default app;

// @ts-nocheck
// Main entry point - Multi-chain cc0strategy indexer
import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import postgres from 'postgres';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import { 
  CHAIN_CONFIGS, 
  SupportedChain, 
  getChainConfig, 
  getRpcUrl, 
  isChainActive,
  getActiveChains,
  validateChain 
} from './config.js';

// ============================================
// CONFIGURATION
// ============================================
const PORT = parseInt(process.env.PORT || '3000');
const DATABASE_URL = process.env.DATABASE_URL || '';

console.log('🚀 cc0strategy Multi-Chain Indexer Starting...');
console.log(`🌐 Port: ${PORT}`);
console.log(`📦 Database: ${DATABASE_URL ? 'configured' : 'NOT SET'}`);

// ============================================
// MULTI-CHAIN RPC CLIENTS
// ============================================
interface RpcStatus {
  url: string | null;
  connected: boolean;
  blockNumber: number | null;
  lastChecked: Date | null;
  error: string | null;
}

const rpcStatus: Record<SupportedChain, RpcStatus> = {
  base: { url: null, connected: false, blockNumber: null, lastChecked: null, error: null },
  ethereum: { url: null, connected: false, blockNumber: null, lastChecked: null, error: null },
};

// Initialize RPC URLs from environment
function initRpcClients() {
  for (const chain of Object.keys(CHAIN_CONFIGS) as SupportedChain[]) {
    const rpcUrl = getRpcUrl(chain);
    if (rpcUrl) {
      rpcStatus[chain].url = rpcUrl;
      console.log(`✅ ${CHAIN_CONFIGS[chain].name} RPC configured`);
    } else {
      console.log(`⚠️ ${CHAIN_CONFIGS[chain].name} RPC not configured (${CHAIN_CONFIGS[chain].rpcEnvKey})`);
    }
  }
}

// Check RPC connection health
async function checkRpcHealth(chain: SupportedChain): Promise<void> {
  const status = rpcStatus[chain];
  if (!status.url) {
    status.connected = false;
    status.error = 'RPC URL not configured';
    return;
  }

  try {
    const response = await fetch(status.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as { result?: string; error?: { message: string } };
    
    if (data.error) {
      throw new Error(data.error.message);
    }

    status.connected = true;
    status.blockNumber = parseInt(data.result || '0', 16);
    status.lastChecked = new Date();
    status.error = null;
  } catch (e: any) {
    status.connected = false;
    status.blockNumber = null;
    status.lastChecked = new Date();
    status.error = e.message;
  }
}

// Check all RPCs
async function checkAllRpcHealth(): Promise<void> {
  await Promise.all(
    (Object.keys(rpcStatus) as SupportedChain[]).map(checkRpcHealth)
  );
}

// Initialize RPC clients
initRpcClients();

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
// WEBSOCKET SERVER
// ============================================
let io: SocketIOServer | null = null;

function emitNewToken(token: any) {
  if (io) {
    console.log(`📡 Emitting new-token event: ${token.symbol}`);
    io.emit('new-token', token);
  }
}

// ============================================
// API SERVER
// ============================================
const app = new Hono();

// Sanitize URL helper
function sanitizeUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return null;
  try { new URL(trimmed); return trimmed; } catch { return null; }
}

// Safe pool_id buffer conversion
function safePoolIdBuffer(poolId: string | null | undefined): Buffer | null {
  if (!poolId || typeof poolId !== 'string') return null;
  const trimmed = poolId.trim();
  if (!trimmed.startsWith('0x') || trimmed.length < 4) return null;
  try {
    return Buffer.from(trimmed.slice(2), 'hex');
  } catch {
    return null;
  }
}

app.use('*', cors());

// Health check with multi-chain RPC status
app.get('/', async (c) => {
  // Check RPC health on each request (with caching via lastChecked)
  const now = Date.now();
  for (const chain of Object.keys(rpcStatus) as SupportedChain[]) {
    const status = rpcStatus[chain];
    // Only recheck if last check was > 30 seconds ago
    if (!status.lastChecked || now - status.lastChecked.getTime() > 30000) {
      await checkRpcHealth(chain);
    }
  }

  return c.json({ 
    status: 'ok', 
    service: 'cc0strategy-indexer',
    version: '2.1.0',
    database: sql ? 'connected' : 'not connected',
    websocket: io ? 'enabled' : 'disabled',
    chains: {
      base: {
        factory: CHAIN_CONFIGS.base.factory,
        contractsDeployed: isChainActive('base'),
        rpc: {
          configured: !!rpcStatus.base.url,
          connected: rpcStatus.base.connected,
          blockNumber: rpcStatus.base.blockNumber,
          error: rpcStatus.base.error,
        },
      },
      ethereum: {
        factory: CHAIN_CONFIGS.ethereum.factory,
        contractsDeployed: isChainActive('ethereum'),
        rpc: {
          configured: !!rpcStatus.ethereum.url,
          connected: rpcStatus.ethereum.connected,
          blockNumber: rpcStatus.ethereum.blockNumber,
          error: rpcStatus.ethereum.error,
        },
      },
    },
    activeChains: getActiveChains(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', async (c) => {
  await checkAllRpcHealth();
  
  const allRpcsHealthy = Object.values(rpcStatus).every(
    s => !s.url || s.connected // Either not configured or connected
  );
  
  return c.json({ 
    status: allRpcsHealthy && sql ? 'healthy' : 'degraded',
    database: sql ? 'ok' : 'error',
    websocket: io ? 'ok' : 'disabled',
    rpcs: Object.fromEntries(
      (Object.keys(rpcStatus) as SupportedChain[]).map(chain => [
        chain, 
        rpcStatus[chain].connected ? 'ok' : (rpcStatus[chain].url ? 'error' : 'not_configured')
      ])
    ),
    timestamp: new Date().toISOString() 
  });
});

// GET /tokens - List all tokens with optional chain filter
app.get('/tokens', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured', tokens: [] }, 500);
  }
  
  try {
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = parseInt(c.req.query('offset') || '0');
    const chainFilter = c.req.query('chain');
    
    // Validate chain if provided
    if (chainFilter && !validateChain(chainFilter)) {
      return c.json({ error: 'Invalid chain. Must be "base" or "ethereum"' }, 400);
    }
    
    let tokens;
    if (chainFilter) {
      tokens = await sql`
        SELECT * FROM tokens 
        WHERE chain = ${chainFilter}
        ORDER BY deployed_at DESC 
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      tokens = await sql`
        SELECT * FROM tokens 
        ORDER BY deployed_at DESC 
        LIMIT ${limit} OFFSET ${offset}
      `;
    }
    
    return c.json({ 
      tokens, 
      pagination: { limit, offset },
      filter: chainFilter ? { chain: chainFilter } : null
    });
  } catch (e: any) {
    console.error('Error fetching tokens:', e.message);
    return c.json({ error: e.message, tokens: [] }, 500);
  }
});

// GET /tokens/:address - Single token (includes chain in response)
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
    
    const token = result[0];
    const chainConfig = getChainConfig(token.chain);
    
    return c.json({
      ...token,
      chainInfo: chainConfig ? {
        chainId: chainConfig.chainId,
        name: chainConfig.name,
        factory: chainConfig.factory,
        feeDistributor: chainConfig.feeDistributor,
      } : null,
    });
  } catch (e: any) {
    console.error('Error fetching token:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// DELETE /tokens/:address - Delete a token (admin only)
app.delete('/tokens/:address', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured' }, 500);
  }
  
  try {
    const address = c.req.param('address').toLowerCase();
    const result = await sql`DELETE FROM tokens WHERE address = ${address} RETURNING *`;
    
    if (!result[0]) {
      return c.json({ error: 'Token not found' }, 404);
    }
    
    console.log(`Deleted token: ${result[0].symbol} (${address})`);
    return c.json({ success: true, deleted: result[0] });
  } catch (e: any) {
    console.error('Error deleting token:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// POST /tokens - Register new token
app.post('/tokens', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured' }, 500);
  }
  
  try {
    // Parse request body
    let body;
    try {
      body = await c.req.json();
    } catch (parseError: any) {
      console.error('JSON parse error:', parseError.message);
      return c.json({ error: 'Invalid JSON: ' + parseError.message }, 400);
    }
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
      website_url,
      twitter_url,
      telegram_url,
      discord_url,
    } = body;
    
    // Validate required fields
    if (!address || !name || !symbol || !nft_collection || !deployer || !deploy_tx_hash) {
      return c.json({ error: 'Missing required fields' }, 400);
    }
    
    // Validate chain
    if (!validateChain(chain)) {
      return c.json({ error: 'Invalid chain. Must be "base" or "ethereum"' }, 400);
    }
    
    // Insert token
    const result = await sql`
      INSERT INTO tokens (
        address, name, symbol, decimals, nft_collection, deployer,
        deploy_tx_hash, deploy_block, deployed_at, image_url, description, pool_id, chain,
        website_url, twitter_url, telegram_url, discord_url
      ) VALUES (
        ${address.toLowerCase()}, ${name}, ${symbol}, ${decimals}, ${nft_collection.toLowerCase()},
        ${deployer.toLowerCase()}, ${deploy_tx_hash}, ${deploy_block},
        ${deployed_at || new Date().toISOString()}, ${image_url || null}, ${description || null},
        ${safePoolIdBuffer(pool_id)}, ${chain},
        ${sanitizeUrl(website_url)}, ${sanitizeUrl(twitter_url)}, ${sanitizeUrl(telegram_url)}, ${sanitizeUrl(discord_url)}
      )
      ON CONFLICT (address) DO UPDATE SET
        name = EXCLUDED.name,
        symbol = EXCLUDED.symbol,
        image_url = COALESCE(EXCLUDED.image_url, tokens.image_url),
        description = COALESCE(EXCLUDED.description, tokens.description),
        website_url = COALESCE(EXCLUDED.website_url, tokens.website_url),
        twitter_url = COALESCE(EXCLUDED.twitter_url, tokens.twitter_url),
        telegram_url = COALESCE(EXCLUDED.telegram_url, tokens.telegram_url),
        discord_url = COALESCE(EXCLUDED.discord_url, tokens.discord_url),
        updated_at = NOW()
      RETURNING *
    `;
    
    const newToken = result[0];
    console.log(`✅ Token registered: ${symbol} (${address}) on ${chain}`);
    
    // Emit WebSocket event for real-time updates
    emitNewToken(newToken);
    
    return c.json(newToken);
  } catch (e: any) {
    console.error('Error registering token:', e.message);
    return c.json({ error: e.message }, 500);
  }
});

// GET /stats - Overall stats with per-chain breakdown
app.get('/stats', async (c) => {
  if (!sql) {
    return c.json({ total_tokens: 0, by_chain: {} });
  }
  
  try {
    const [totalStats] = await sql`SELECT COUNT(*) as total_tokens FROM tokens`;
    const chainStats = await sql`
      SELECT chain, COUNT(*) as count 
      FROM tokens 
      GROUP BY chain
    `;
    
    const byChain: Record<string, number> = {};
    for (const row of chainStats) {
      byChain[row.chain] = parseInt(row.count);
    }
    
    return c.json({
      total_tokens: parseInt(totalStats.total_tokens),
      by_chain: byChain,
      active_chains: getActiveChains(),
    });
  } catch (e: any) {
    return c.json({ total_tokens: 0, by_chain: {}, error: e.message });
  }
});

// GET /config - Return chain configurations (public info only)
app.get('/config', (c) => {
  const publicConfig = Object.fromEntries(
    (Object.keys(CHAIN_CONFIGS) as SupportedChain[]).map(chain => [
      chain,
      {
        chainId: CHAIN_CONFIGS[chain].chainId,
        name: CHAIN_CONFIGS[chain].name,
        factory: CHAIN_CONFIGS[chain].factory,
        feeDistributor: CHAIN_CONFIGS[chain].feeDistributor,
        lpLocker: CHAIN_CONFIGS[chain].lpLocker,
        hook: CHAIN_CONFIGS[chain].hook,
        treasury: CHAIN_CONFIGS[chain].treasury,
        contractsDeployed: isChainActive(chain),
      },
    ])
  );
  
  return c.json({
    chains: publicConfig,
    activeChains: getActiveChains(),
  });
});

// GET /contracts - Contract addresses by chain from database
app.get('/contracts', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured', contracts: [] }, 500);
  }
  
  try {
    const chain = c.req.query('chain') || 'base';
    
    // Validate chain
    if (!validateChain(chain)) {
      return c.json({ error: 'Invalid chain. Must be "base" or "ethereum"' }, 400);
    }
    
    const contracts = await sql`
      SELECT chain, contract_name, address, deployed_at, deploy_tx_hash, notes, created_at 
      FROM contract_addresses 
      WHERE chain = ${chain}
      ORDER BY contract_name
    `;
    
    // Also return as object keyed by contract_name for easy lookup
    const addresses: Record<string, string> = {};
    for (const contract of contracts) {
      addresses[contract.contract_name] = contract.address;
    }
    
    return c.json({ 
      chain, 
      contracts, 
      addresses 
    });
  } catch (e: any) {
    console.error('Error fetching contracts:', e.message);
    return c.json({ error: e.message, contracts: [] }, 500);
  }
});

// GET /migrate - Run schema migrations (one-time fix)
app.get('/migrate', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured' }, 500);
  }
  
  const results: string[] = [];
  
  // All columns that should exist
  const columns = [
    { name: 'decimals', type: 'INTEGER NOT NULL DEFAULT 18' },
    { name: 'chain', type: "VARCHAR(20) NOT NULL DEFAULT 'base'" },
    { name: 'nft_collection_name', type: 'VARCHAR(255)' },
    { name: 'deploy_tx_hash', type: 'VARCHAR(66)' },
    { name: 'deploy_block', type: 'BIGINT DEFAULT 0' },
    { name: 'deployed_at', type: 'TIMESTAMP WITH TIME ZONE DEFAULT NOW()' },
    { name: 'image_url', type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'pool_id', type: 'BYTEA' },
    { name: 'pool_address', type: 'VARCHAR(42)' },
    { name: 'website_url', type: 'TEXT' },
    { name: 'twitter_url', type: 'TEXT' },
    { name: 'created_at', type: 'TIMESTAMP WITH TIME ZONE DEFAULT NOW()' },
    { name: 'updated_at', type: 'TIMESTAMP WITH TIME ZONE DEFAULT NOW()' },
  ];
  
  for (const col of columns) {
    try {
      await sql.unsafe(`ALTER TABLE tokens ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
      results.push(`✅ ${col.name}`);
    } catch (e: any) {
      results.push(`⚠️ ${col.name}: ${e.message}`);
    }
  }
  
  try {
    await sql`CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens(chain)`;
    results.push('✅ chain index');
  } catch (e: any) {
    results.push(`⚠️ chain index: ${e.message}`);
  }
  
  // Insert MFERSTR if not exists
  try {
    await sql`
      INSERT INTO tokens (address, name, symbol, decimals, nft_collection, nft_collection_name, deployer, deploy_tx_hash, deploy_block, deployed_at, description, image_url, pool_id, chain)
      VALUES (
        '0x0860d4f54de8d47982a4530b496f71b4cb85b9ac',
        'mferStrategy',
        'MFERSTR',
        18,
        '0x79fcdef22feed20eddacbb2587640e45491b757f',
        'mfers',
        '0x9fc58fdfe6b2c8ec6688ae74bda0a3a269ef1201',
        '0xf7ef37ffd0d0360d11fa1aac85e5082ee5e07c641f5fff83f3458ea0aae77f4f',
        24460202,
        '2026-02-24T09:00:00Z',
        'First token on cc0strategy for mfers holders. 80% of trading fees go to mfers NFT holders.',
        'ipfs://QmWiQE65tmpYzcokCheQmng2DCM33DEhjXcPB6PanwpAZo',
        decode('458172bf46475e851b0e78f83d721c6bec86ad74a99caa1e3634fa5bb88a77ad', 'hex'),
        'ethereum'
      )
      ON CONFLICT (address) DO UPDATE SET
        pool_id = decode('458172bf46475e851b0e78f83d721c6bec86ad74a99caa1e3634fa5bb88a77ad', 'hex'),
        chain = 'ethereum'
    `;
    results.push('✅ MFERSTR inserted/updated');
  } catch (e: any) {
    results.push(`⚠️ MFERSTR: ${e.message}`);
  }
  
  return c.json({ 
    status: 'migration complete',
    results 
  });
});

// ============================================
// START SERVER WITH WEBSOCKET
// ============================================
console.log(`🚀 Starting server on port ${PORT}...`);

// Initial RPC health check
checkAllRpcHealth().then(() => {
  console.log('📡 Initial RPC health check complete');
});

// Create HTTP server and attach Socket.IO
const httpServer = createServer(async (req, res) => {
  // Collect request body for POST/PUT/PATCH
  let body: Buffer[] = [];
  for await (const chunk of req) {
    body.push(chunk);
  }
  const bodyBuffer = Buffer.concat(body);
  
  // Let Hono handle HTTP requests - include body for non-GET requests
  const requestInit: RequestInit = {
    method: req.method,
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([_, v]) => v !== undefined) as [string, string][]
    ),
  };
  
  // Add body for methods that support it
  if (req.method !== 'GET' && req.method !== 'HEAD' && bodyBuffer.length > 0) {
    requestInit.body = bodyBuffer;
  }
  
  app.fetch(new Request(`http://localhost${req.url}`, requestInit)).then(async (response) => {
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const body = await response.text();
    res.end(body);
  }).catch((err) => {
    console.error('Request error:', err);
    res.statusCode = 500;
    res.end('Internal Server Error');
  });
});

// Initialize Socket.IO
io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Start the server
httpServer.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  console.log(`📡 WebSocket enabled on same port`);
  console.log(`📋 Active chains: ${getActiveChains().join(', ') || 'none'}`);
});

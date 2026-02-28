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
import { createMarketplaceRoutes } from './marketplace.js';
import { initOpenSeaStream, setSocketIoServer, subscribeToCollection, unsubscribeFromCollection, getStreamStatus, onEvent } from './opensea-stream.js';

// ============================================
// CACHE CONFIGURATION
// ============================================
const MARKET_DATA_REFRESH_MS = 60 * 1000;  // 60 seconds
const REWARDS_REFRESH_MS = 30 * 1000;       // 30 seconds
const COLLECTION_INFO_REFRESH_MS = 5 * 60 * 1000; // 5 minutes (rarely changes)

interface MarketData {
  priceUsd: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  fdv: number;
  liquidity: number;
  lastUpdated: number;
}

interface RewardsData {
  totalRewards: string;
  accRewardPerNFT: string;
  nftSupply: string;
  lastUpdated: number;
}

interface CollectionInfo {
  name: string | null;
  image: string | null;
  lastUpdated: number;
}

interface TokenCache {
  address: string;
  chain: SupportedChain;
  market?: MarketData;
  rewards?: RewardsData;
}

// In-memory caches
const marketCache: Map<string, MarketData> = new Map();
const rewardsCache: Map<string, RewardsData> = new Map();
const collectionCache: Map<string, CollectionInfo> = new Map();
let lastMarketRefresh = 0;
let lastRewardsRefresh = 0;
let cacheRefreshInProgress = false;

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
// CACHE REFRESH FUNCTIONS
// ============================================

// FeeDistributor ABI (minimal for rewards)
const FEE_DISTRIBUTOR_ABI = [
  {
    name: 'accumulatedRewards',
    type: 'function',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'tokenToNftSupply',
    type: 'function',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
];

// ABI encode function call
function encodeCall(funcName: string, args: string[]): string {
  // Simple encoder for our specific case: single address arg
  const funcSigs: Record<string, string> = {
    'accumulatedRewards': '0x73f273fc',  // bytes4(keccak256("accumulatedRewards(address)"))
    'tokenToNftSupply': '0x8fb0cb97',    // bytes4(keccak256("tokenToNftSupply(address)"))
  };
  const selector = funcSigs[funcName];
  if (!selector) throw new Error(`Unknown function: ${funcName}`);
  // Pad address to 32 bytes
  const paddedArg = args[0].toLowerCase().replace('0x', '').padStart(64, '0');
  return selector + paddedArg;
}

// Decode uint256 from RPC response
function decodeUint256(hex: string): bigint {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

// Format wei to ETH string
function formatEther(wei: bigint): string {
  const str = wei.toString().padStart(19, '0');
  const intPart = str.slice(0, -18) || '0';
  const decPart = str.slice(-18).replace(/0+$/, '') || '0';
  return decPart === '0' ? intPart : `${intPart}.${decPart}`;
}

// Fetch market data from GeckoTerminal
async function fetchMarketData(tokenAddress: string, chain: SupportedChain): Promise<MarketData | null> {
  const networkId = chain === 'ethereum' ? 'eth' : 'base';
  const poolsUrl = `https://api.geckoterminal.com/api/v2/networks/${networkId}/tokens/${tokenAddress.toLowerCase()}/pools?page=1`;
  
  try {
    const response = await fetch(poolsUrl, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const pools = data.data;
    
    if (!pools || pools.length === 0) return null;
    
    const pool = pools[0];
    const poolAttrs = pool.attributes;
    if (!poolAttrs) return null;
    
    // Get price from pool - check which token we need
    const baseTokenPrice = parseFloat(poolAttrs.base_token_price_usd || '0');
    const quoteTokenPrice = parseFloat(poolAttrs.quote_token_price_usd || '0');
    const baseTokenAddr = pool.relationships?.base_token?.data?.id?.split('_')[1]?.toLowerCase();
    const isBaseToken = baseTokenAddr === tokenAddress.toLowerCase();
    const priceUsd = isBaseToken ? baseTokenPrice : quoteTokenPrice;
    
    return {
      priceUsd,
      priceChange24h: parseFloat(poolAttrs.price_change_percentage?.h24 || '0'),
      volume24h: parseFloat(poolAttrs.volume_usd?.h24 || '0'),
      marketCap: parseFloat(poolAttrs.market_cap_usd || '0') || parseFloat(poolAttrs.fdv_usd || '0'),
      fdv: parseFloat(poolAttrs.fdv_usd || '0'),
      liquidity: parseFloat(poolAttrs.reserve_in_usd || '0'),
      lastUpdated: Date.now(),
    };
  } catch (e) {
    console.error(`GeckoTerminal error for ${tokenAddress}:`, e);
    return null;
  }
}

// Fetch rewards data from FeeDistributor
async function fetchRewardsData(tokenAddress: string, chain: SupportedChain): Promise<RewardsData | null> {
  const rpcUrl = getRpcUrl(chain);
  const config = CHAIN_CONFIGS[chain];
  
  if (!rpcUrl || !config.feeDistributor) return null;
  
  try {
    // Batch RPC calls
    const calls = [
      {
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: config.feeDistributor, data: encodeCall('accumulatedRewards', [tokenAddress]) }, 'latest'],
        id: 1,
      },
      {
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: config.feeDistributor, data: encodeCall('tokenToNftSupply', [tokenAddress]) }, 'latest'],
        id: 2,
      },
    ];
    
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(calls),
    });
    
    if (!response.ok) return null;
    
    const results = await response.json();
    
    const accRewardPerNFT = decodeUint256(results[0]?.result);
    const nftSupply = decodeUint256(results[1]?.result);
    
    // Total rewards = accRewardPerNFT * nftSupply / 1e18 (PRECISION)
    const totalRewardsWei = (accRewardPerNFT * nftSupply) / (10n ** 18n);
    
    return {
      totalRewards: formatEther(totalRewardsWei),
      accRewardPerNFT: accRewardPerNFT.toString(),
      nftSupply: nftSupply.toString(),
      lastUpdated: Date.now(),
    };
  } catch (e) {
    console.error(`Rewards fetch error for ${tokenAddress} on ${chain}:`, e);
    return null;
  }
}

// Fetch collection info from OpenSea/Reservoir
async function fetchCollectionInfo(collectionAddress: string, chain: SupportedChain): Promise<CollectionInfo | null> {
  // Try OpenSea API first (public endpoint)
  const networkSlug = chain === 'ethereum' ? 'ethereum' : 'base';
  const url = `https://api.opensea.io/api/v2/chain/${networkSlug}/contract/${collectionAddress.toLowerCase()}`;
  
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    
    if (response.ok) {
      const data = await response.json();
      return {
        name: data.collection || data.name || null,
        image: data.image_url || null,
        lastUpdated: Date.now(),
      };
    }
  } catch (e) {
    console.error(`Collection info error for ${collectionAddress}:`, e);
  }
  
  return null;
}

// Refresh all market data
async function refreshMarketCache(): Promise<void> {
  if (!sql || cacheRefreshInProgress) return;
  
  const now = Date.now();
  if (now - lastMarketRefresh < MARKET_DATA_REFRESH_MS) return;
  
  try {
    const tokens = await sql`SELECT address, chain FROM tokens`;
    console.log(`📊 Refreshing market data for ${tokens.length} tokens...`);
    
    // Process in parallel with rate limiting (5 concurrent)
    const batchSize = 5;
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      await Promise.all(batch.map(async (token) => {
        const data = await fetchMarketData(token.address, token.chain as SupportedChain);
        if (data) {
          marketCache.set(`${token.chain}:${token.address.toLowerCase()}`, data);
        }
      }));
      // Small delay between batches to avoid rate limits
      if (i + batchSize < tokens.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    
    lastMarketRefresh = now;
    console.log(`✅ Market cache refreshed (${marketCache.size} entries)`);
  } catch (e) {
    console.error('Market cache refresh error:', e);
  }
}

// Refresh all rewards data
async function refreshRewardsCache(): Promise<void> {
  if (!sql || cacheRefreshInProgress) return;
  
  const now = Date.now();
  if (now - lastRewardsRefresh < REWARDS_REFRESH_MS) return;
  
  try {
    const tokens = await sql`SELECT address, chain FROM tokens`;
    console.log(`💰 Refreshing rewards data for ${tokens.length} tokens...`);
    
    // Process per chain (batch RPC calls within same chain)
    for (const chain of ['base', 'ethereum'] as SupportedChain[]) {
      const chainTokens = tokens.filter(t => t.chain === chain);
      
      await Promise.all(chainTokens.map(async (token) => {
        const data = await fetchRewardsData(token.address, chain);
        if (data) {
          rewardsCache.set(`${chain}:${token.address.toLowerCase()}`, data);
        }
      }));
    }
    
    lastRewardsRefresh = now;
    console.log(`✅ Rewards cache refreshed (${rewardsCache.size} entries)`);
  } catch (e) {
    console.error('Rewards cache refresh error:', e);
  }
}

// Full cache refresh (market + rewards)
async function refreshAllCaches(): Promise<void> {
  if (cacheRefreshInProgress) return;
  cacheRefreshInProgress = true;
  
  try {
    await Promise.all([
      refreshMarketCache(),
      refreshRewardsCache(),
    ]);
  } finally {
    cacheRefreshInProgress = false;
  }
}

// Start background cache refresh loops
function startCacheRefreshLoops(): void {
  // Initial refresh after 5 seconds
  setTimeout(() => {
    refreshAllCaches();
  }, 5000);
  
  // Market data: every 60 seconds
  setInterval(() => {
    refreshMarketCache();
  }, MARKET_DATA_REFRESH_MS);
  
  // Rewards data: every 30 seconds
  setInterval(() => {
    refreshRewardsCache();
  }, REWARDS_REFRESH_MS);
  
  console.log('🔄 Cache refresh loops started');
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
// Mount marketplace routes
app.route('/marketplace', createMarketplaceRoutes(sql));

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

// ============================================
// CACHE API ENDPOINTS
// ============================================

// GET /cache/market - All cached market data
app.get('/cache/market', (c) => {
  const chainFilter = c.req.query('chain');
  const result: Record<string, MarketData> = {};
  
  for (const [key, data] of marketCache.entries()) {
    const [chain, address] = key.split(':');
    if (!chainFilter || chain === chainFilter) {
      result[address] = data;
    }
  }
  
  return c.json({
    data: result,
    count: Object.keys(result).length,
    lastRefresh: lastMarketRefresh,
    nextRefresh: lastMarketRefresh + MARKET_DATA_REFRESH_MS,
    filter: chainFilter || null,
  });
});

// GET /cache/rewards - All cached rewards data
app.get('/cache/rewards', (c) => {
  const chainFilter = c.req.query('chain');
  const result: Record<string, RewardsData> = {};
  
  for (const [key, data] of rewardsCache.entries()) {
    const [chain, address] = key.split(':');
    if (!chainFilter || chain === chainFilter) {
      result[address] = data;
    }
  }
  
  return c.json({
    data: result,
    count: Object.keys(result).length,
    lastRefresh: lastRewardsRefresh,
    nextRefresh: lastRewardsRefresh + REWARDS_REFRESH_MS,
    filter: chainFilter || null,
  });
});

// GET /cache/all - Combined market + rewards for all tokens (main endpoint for frontend)
app.get('/cache/all', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured' }, 500);
  }
  
  const chainFilter = c.req.query('chain');
  
  try {
    // Get tokens from DB
    let tokens;
    if (chainFilter && validateChain(chainFilter)) {
      tokens = await sql`SELECT address, chain, name, symbol, nft_collection, image_url, deployed_at, website_url, twitter_url, telegram_url, discord_url, deployer, is_verified FROM tokens WHERE chain = ${chainFilter} ORDER BY deployed_at DESC`;
    } else {
      tokens = await sql`SELECT address, chain, name, symbol, nft_collection, image_url, deployed_at, website_url, twitter_url, telegram_url, discord_url, deployer, is_verified FROM tokens ORDER BY deployed_at DESC`;
    }
    
    // Combine with cache data
    const combined = tokens.map((token: any) => {
      const cacheKey = `${token.chain}:${token.address.toLowerCase()}`;
      const market = marketCache.get(cacheKey);
      const rewards = rewardsCache.get(cacheKey);
      
      return {
        address: token.address,
        chain: token.chain,
        name: token.name,
        symbol: token.symbol,
        nftCollection: token.nft_collection,
        imageUrl: token.image_url,
        deployedAt: token.deployed_at,
        websiteUrl: token.website_url,
        twitterUrl: token.twitter_url,
        telegramUrl: token.telegram_url,
        discordUrl: token.discord_url,
        deployer: token.deployer,
        isVerified: token.is_verified || false,
        market: market ? {
          priceUsd: market.priceUsd,
          priceChange24h: market.priceChange24h,
          volume24h: market.volume24h,
          marketCap: market.marketCap,
          fdv: market.fdv,
          liquidity: market.liquidity,
        } : null,
        rewards: rewards ? {
          totalRewards: rewards.totalRewards,
          accRewardPerNFT: rewards.accRewardPerNFT,
          nftSupply: rewards.nftSupply,
        } : null,
      };
    });
    
    return c.json({
      tokens: combined,
      count: combined.length,
      cache: {
        marketLastRefresh: lastMarketRefresh,
        rewardsLastRefresh: lastRewardsRefresh,
      },
      filter: chainFilter || null,
    });
  } catch (e: any) {
    console.error('Cache/all error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// GET /cache/token/:address - Single token cached data
app.get('/cache/token/:address', async (c) => {
  if (!sql) {
    return c.json({ error: 'Database not configured' }, 500);
  }
  
  const address = c.req.param('address').toLowerCase();
  
  try {
    const [token] = await sql`SELECT * FROM tokens WHERE address = ${address}`;
    if (!token) {
      return c.json({ error: 'Token not found' }, 404);
    }
    
    const cacheKey = `${token.chain}:${address}`;
    const market = marketCache.get(cacheKey);
    const rewards = rewardsCache.get(cacheKey);
    
    return c.json({
      token: {
        address: token.address,
        chain: token.chain,
        name: token.name,
        symbol: token.symbol,
        nftCollection: token.nft_collection,
        imageUrl: token.image_url,
        deployedAt: token.deployed_at,
        websiteUrl: token.website_url,
        twitterUrl: token.twitter_url,
        telegramUrl: token.telegram_url,
        discordUrl: token.discord_url,
        deployer: token.deployer,
        isVerified: token.is_verified || false,
      },
      market: market || null,
      rewards: rewards || null,
    });
  } catch (e: any) {
    console.error('Cache/token error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// POST /cache/refresh - Force cache refresh (for admin/testing)
app.post('/cache/refresh', async (c) => {
  if (cacheRefreshInProgress) {
    return c.json({ status: 'already_in_progress' });
  }
  
  // Don't await - return immediately
  refreshAllCaches();
  
  return c.json({ 
    status: 'started',
    message: 'Cache refresh initiated',
  });
});

// GET /cache/status - Cache status info
app.get('/cache/status', (c) => {
  const now = Date.now();
  return c.json({
    market: {
      entries: marketCache.size,
      lastRefresh: lastMarketRefresh,
      nextRefresh: lastMarketRefresh + MARKET_DATA_REFRESH_MS,
      stale: now - lastMarketRefresh > MARKET_DATA_REFRESH_MS,
      refreshIntervalMs: MARKET_DATA_REFRESH_MS,
    },
    rewards: {
      entries: rewardsCache.size,
      lastRefresh: lastRewardsRefresh,
      nextRefresh: lastRewardsRefresh + REWARDS_REFRESH_MS,
      stale: now - lastRewardsRefresh > REWARDS_REFRESH_MS,
      refreshIntervalMs: REWARDS_REFRESH_MS,
    },
    refreshInProgress: cacheRefreshInProgress,
    timestamp: now,
  });
});

// GET /stream/status - OpenSea Stream API status
app.get('/stream/status', (c) => {
  return c.json(getStreamStatus());
});

// POST /stream/subscribe/:collection - Subscribe to collection events
app.post('/stream/subscribe/:collection', (c) => {
  const collection = c.req.param('collection');
  subscribeToCollection(collection);
  return c.json({ success: true, collection, status: getStreamStatus() });
});

// POST /stream/unsubscribe/:collection - Unsubscribe from collection events
app.post('/stream/unsubscribe/:collection', (c) => {
  const collection = c.req.param('collection');
  unsubscribeFromCollection(collection);
  return c.json({ success: true, collection, status: getStreamStatus() });
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

// Start cache refresh loops
startCacheRefreshLoops();

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
  
  // Join 'all' room by default for global events
  socket.join('all');
  
  // Subscribe to a collection for real-time updates
  socket.on('subscribe:collection', (collectionSlug: string) => {
    console.log(`📡 ${socket.id} subscribed to collection: ${collectionSlug}`);
    socket.join(collectionSlug);
    
    // Subscribe to OpenSea stream for this collection
    subscribeToCollection(collectionSlug);
  });
  
  // Unsubscribe from a collection
  socket.on('unsubscribe:collection', (collectionSlug: string) => {
    console.log(`📴 ${socket.id} unsubscribed from collection: ${collectionSlug}`);
    socket.leave(collectionSlug);
    
    // Check if any other clients are in this room
    const room = io?.sockets.adapter.rooms.get(collectionSlug);
    if (!room || room.size === 0) {
      unsubscribeFromCollection(collectionSlug);
    }
  });
  
  // Get stream status
  socket.on('stream:status', (callback: (status: any) => void) => {
    callback(getStreamStatus());
  });
  
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Set Socket.IO server for OpenSea stream to broadcast events
setSocketIoServer(io);

// Initialize OpenSea Stream API
initOpenSeaStream();

// Log OpenSea events
onEvent((event) => {
  console.log(`📨 OpenSea event: ${event.event_type} - ${event.collection_slug || event.collection_address} #${event.token_id}`);
});

// Start the server
httpServer.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  console.log(`📡 WebSocket enabled on same port`);
  console.log(`📋 Active chains: ${getActiveChains().join(', ') || 'none'}`);
});

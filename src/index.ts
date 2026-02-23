// Main entry point - runs both API and indexer
import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { createPublicClient, http, parseAbiItem, decodeEventLog, type Log, type Address } from 'viem';
import { base } from 'viem/chains';
import { sql, insertToken, getTokens, getTokenByAddress, getSwapsForToken, getOHLCV, getIndexerState, updateIndexerState } from './db/index.js';

// ============================================
// CONFIGURATION
// ============================================
const FACTORY_ADDRESS = '0x70b17db500Ce1746BB34f908140d0279C183f3eb' as Address;
const START_BLOCK = 26700000n;
const PORT = parseInt(process.env.PORT || '3000');

// Event signature
const TokenDeployedEvent = parseAbiItem(
  'event TokenDeployed(address indexed token, address indexed nftCollection, bytes32 poolId, address deployer)'
);

// ERC20 ABI
const erc20Abi = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

// Viem client
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const rpcUrl = ALCHEMY_API_KEY 
  ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
  : 'https://mainnet.base.org';

const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

// ============================================
// API SERVER
// ============================================
const app = new Hono();

app.use('*', cors());
app.use('*', logger());

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'cc0strategy-indexer', factory: FACTORY_ADDRESS }));
app.get('/health', (c) => c.json({ status: 'healthy', timestamp: new Date().toISOString() }));

// GET /tokens - List all tokens (paginated)
app.get('/tokens', async (c) => {
  try {
    const sortBy = c.req.query('sort') as 'deployed_at' | 'volume_24h' | 'tvl' || 'deployed_at';
    const order = c.req.query('order') as 'asc' | 'desc' || 'desc';
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = parseInt(c.req.query('offset') || '0');

    const tokens = await getTokens({ sortBy, order, limit, offset });
    return c.json({ tokens, pagination: { limit, offset } });
  } catch (e: any) {
    console.error('Error fetching tokens:', e);
    return c.json({ error: 'Failed to fetch tokens' }, 500);
  }
});

// GET /tokens/:address - Single token details
app.get('/tokens/:address', async (c) => {
  try {
    const address = c.req.param('address').toLowerCase();
    const token = await getTokenByAddress(address);
    if (!token) return c.json({ error: 'Token not found' }, 404);
    return c.json(token);
  } catch (e: any) {
    console.error('Error fetching token:', e);
    return c.json({ error: 'Failed to fetch token' }, 500);
  }
});

// GET /tokens/:address/swaps - Recent trades
app.get('/tokens/:address/swaps', async (c) => {
  try {
    const address = c.req.param('address').toLowerCase();
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const swaps = await getSwapsForToken(address, limit);
    return c.json({ swaps });
  } catch (e: any) {
    return c.json({ error: 'Failed to fetch swaps' }, 500);
  }
});

// GET /tokens/:address/chart - OHLCV data
app.get('/tokens/:address/chart', async (c) => {
  try {
    const address = c.req.param('address').toLowerCase();
    const interval = c.req.query('interval') || '1h';
    const limit = Math.min(parseInt(c.req.query('limit') || '100'), 500);
    const candles = await getOHLCV(address, interval, limit);
    return c.json({ candles: candles.reverse() });
  } catch (e: any) {
    return c.json({ error: 'Failed to fetch chart data' }, 500);
  }
});

// GET /stats - Global stats
app.get('/stats', async (c) => {
  try {
    const [stats] = await sql`
      SELECT 
        COUNT(*) as total_tokens,
        COALESCE(SUM(ts.volume_24h::numeric), 0) as total_volume_24h,
        COALESCE(SUM(ts.total_fees_distributed::numeric), 0) as total_fees
      FROM tokens t
      LEFT JOIN token_stats ts ON t.address = ts.token_address
    `;
    return c.json(stats);
  } catch (e: any) {
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// ============================================
// INDEXER
// ============================================
async function fetchTokenMetadata(tokenAddress: Address) {
  try {
    const [name, symbol, decimals] = await Promise.all([
      client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return { name, symbol, decimals };
  } catch (e) {
    console.warn(`Failed to fetch metadata for ${tokenAddress}`);
    return { name: 'Unknown', symbol: 'UNKNOWN', decimals: 18 };
  }
}

async function handleTokenDeployed(log: Log) {
  try {
    const decoded = decodeEventLog({
      abi: [TokenDeployedEvent],
      data: log.data,
      topics: log.topics,
    });
    
    const { token, nftCollection, poolId, deployer } = decoded.args as {
      token: Address;
      nftCollection: Address;
      poolId: `0x${string}`;
      deployer: Address;
    };
    
    console.log(`📦 TokenDeployed: ${token} | NFT: ${nftCollection} | Block: ${log.blockNumber}`);
    
    const block = await client.getBlock({ blockNumber: log.blockNumber! });
    const metadata = await fetchTokenMetadata(token);
    
    await insertToken({
      address: token.toLowerCase(),
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      nftCollection: nftCollection.toLowerCase(),
      nftCollectionName: null,
      poolAddress: null,
      poolId: poolId,
      deployer: deployer.toLowerCase(),
      deployedAt: new Date(Number(block.timestamp) * 1000),
      deployTxHash: log.transactionHash!,
      deployBlock: log.blockNumber!,
      description: null,
      imageUrl: null,
      websiteUrl: null,
      twitterUrl: null,
    });
    
    console.log(`✅ Inserted: ${metadata.symbol}`);
  } catch (e: any) {
    if (e.message?.includes('unique constraint') || e.message?.includes('duplicate')) {
      // Token already exists
    } else {
      console.error('Error handling TokenDeployed:', e.message);
    }
  }
}

async function runIndexer() {
  console.log('🔄 Running indexer...');
  
  try {
    const state = await getIndexerState('factory');
    let fromBlock = state?.lastBlock ? state.lastBlock + 1n : START_BLOCK;
    const currentBlock = await client.getBlockNumber();
    
    if (fromBlock >= currentBlock) {
      console.log('✅ Already up to date');
      return;
    }
    
    console.log(`📊 Scanning blocks ${fromBlock} to ${currentBlock}`);
    
    const batchSize = 10000n;
    let totalFound = 0;
    
    while (fromBlock <= currentBlock) {
      const toBlock = fromBlock + batchSize > currentBlock ? currentBlock : fromBlock + batchSize;
      
      const logs = await client.getLogs({
        address: FACTORY_ADDRESS,
        event: TokenDeployedEvent,
        fromBlock,
        toBlock,
      });
      
      if (logs.length > 0) {
        console.log(`   Found ${logs.length} events in blocks ${fromBlock}-${toBlock}`);
        totalFound += logs.length;
        
        for (const log of logs) {
          await handleTokenDeployed(log);
        }
      }
      
      await updateIndexerState('factory', toBlock);
      fromBlock = toBlock + 1n;
    }
    
    console.log(`✅ Indexer complete. Found ${totalFound} new tokens.`);
  } catch (e: any) {
    console.error('Indexer error:', e.message);
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('🚀 cc0strategy Indexer Service');
  console.log(`📍 Factory: ${FACTORY_ADDRESS}`);
  console.log(`🔗 RPC: ${rpcUrl.replace(ALCHEMY_API_KEY || '', '***')}`);
  console.log(`🌐 Port: ${PORT}`);
  
  // Run migrations
  console.log('📦 Running migrations...');
  try {
    await import('./db/migrate.js');
    // Give migrations a moment
    await new Promise(r => setTimeout(r, 2000));
  } catch (e: any) {
    console.error('Migration error:', e.message);
  }
  
  // Start API server
  console.log(`🚀 Starting API server on port ${PORT}...`);
  serve({ fetch: app.fetch, port: PORT });
  
  // Run indexer on startup
  console.log('🔍 Running initial indexer...');
  await runIndexer();
  
  // Schedule indexer every 5 minutes
  const FIVE_MINUTES = 5 * 60 * 1000;
  setInterval(runIndexer, FIVE_MINUTES);
  
  console.log('✅ Service running');
}

main().catch(console.error);

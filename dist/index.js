// Main entry point - Multi-chain cc0strategy indexer
import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import postgres from 'postgres';
import { CHAIN_CONFIGS, getChainConfig, getRpcUrl, isChainActive, getActiveChains, validateChain } from './config.js';
// ============================================
// CONFIGURATION
// ============================================
const PORT = parseInt(process.env.PORT || '3000');
const DATABASE_URL = process.env.DATABASE_URL || '';
console.log('🚀 cc0strategy Multi-Chain Indexer Starting...');
console.log(`🌐 Port: ${PORT}`);
console.log(`📦 Database: ${DATABASE_URL ? 'configured' : 'NOT SET'}`);
const rpcStatus = {
    base: { url: null, connected: false, blockNumber: null, lastChecked: null, error: null },
    ethereum: { url: null, connected: false, blockNumber: null, lastChecked: null, error: null },
};
// Initialize RPC URLs from environment
function initRpcClients() {
    for (const chain of Object.keys(CHAIN_CONFIGS)) {
        const rpcUrl = getRpcUrl(chain);
        if (rpcUrl) {
            rpcStatus[chain].url = rpcUrl;
            console.log(`✅ ${CHAIN_CONFIGS[chain].name} RPC configured`);
        }
        else {
            console.log(`⚠️ ${CHAIN_CONFIGS[chain].name} RPC not configured (${CHAIN_CONFIGS[chain].rpcEnvKey})`);
        }
    }
}
// Check RPC connection health
async function checkRpcHealth(chain) {
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
        const data = await response.json();
        if (data.error) {
            throw new Error(data.error.message);
        }
        status.connected = true;
        status.blockNumber = parseInt(data.result || '0', 16);
        status.lastChecked = new Date();
        status.error = null;
    }
    catch (e) {
        status.connected = false;
        status.blockNumber = null;
        status.lastChecked = new Date();
        status.error = e.message;
    }
}
// Check all RPCs
async function checkAllRpcHealth() {
    await Promise.all(Object.keys(rpcStatus).map(checkRpcHealth));
}
// Initialize RPC clients
initRpcClients();
// ============================================
// DATABASE
// ============================================
let sql = null;
if (DATABASE_URL) {
    try {
        sql = postgres(DATABASE_URL, {
            max: 5,
            idle_timeout: 20,
            connect_timeout: 30,
        });
        console.log('✅ Database configured');
    }
    catch (e) {
        console.error('❌ Database connection error:', e.message);
    }
}
// Placeholder for future event indexing
async function startEventIndexer(_config) {
    // TODO: Implement when ready
    console.log(`📡 Event indexing placeholder for ${_config.chain}:${_config.eventName}`);
}
// ============================================
// API SERVER
// ============================================
const app = new Hono();
app.use('*', cors());
// Health check with multi-chain RPC status
app.get('/', async (c) => {
    // Check RPC health on each request (with caching via lastChecked)
    const now = Date.now();
    for (const chain of Object.keys(rpcStatus)) {
        const status = rpcStatus[chain];
        // Only recheck if last check was > 30 seconds ago
        if (!status.lastChecked || now - status.lastChecked.getTime() > 30000) {
            await checkRpcHealth(chain);
        }
    }
    return c.json({
        status: 'ok',
        service: 'cc0strategy-indexer',
        version: '2.0.0',
        database: sql ? 'connected' : 'not connected',
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
    const allRpcsHealthy = Object.values(rpcStatus).every(s => !s.url || s.connected // Either not configured or connected
    );
    return c.json({
        status: allRpcsHealthy && sql ? 'healthy' : 'degraded',
        database: sql ? 'ok' : 'error',
        rpcs: Object.fromEntries(Object.keys(rpcStatus).map(chain => [
            chain,
            rpcStatus[chain].connected ? 'ok' : (rpcStatus[chain].url ? 'error' : 'not_configured')
        ])),
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
            tokens = await sql `
        SELECT * FROM tokens 
        WHERE chain = ${chainFilter}
        ORDER BY deployed_at DESC 
        LIMIT ${limit} OFFSET ${offset}
      `;
        }
        else {
            tokens = await sql `
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
    }
    catch (e) {
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
        const result = await sql `SELECT * FROM tokens WHERE address = ${address}`;
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
    }
    catch (e) {
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
        const { address, name, symbol, decimals = 18, nft_collection, deployer, deploy_tx_hash, deploy_block = 0, deployed_at, image_url, description, pool_id, chain = 'base', } = body;
        // Validate required fields
        if (!address || !name || !symbol || !nft_collection || !deployer || !deploy_tx_hash) {
            return c.json({ error: 'Missing required fields' }, 400);
        }
        // Validate chain
        if (!validateChain(chain)) {
            return c.json({ error: 'Invalid chain. Must be "base" or "ethereum"' }, 400);
        }
        // Insert token
        const result = await sql `
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
        console.log(`✅ Token registered: ${symbol} (${address}) on ${chain}`);
        return c.json(result[0]);
    }
    catch (e) {
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
        const [totalStats] = await sql `SELECT COUNT(*) as total_tokens FROM tokens`;
        const chainStats = await sql `
      SELECT chain, COUNT(*) as count 
      FROM tokens 
      GROUP BY chain
    `;
        const byChain = {};
        for (const row of chainStats) {
            byChain[row.chain] = parseInt(row.count);
        }
        return c.json({
            total_tokens: parseInt(totalStats.total_tokens),
            by_chain: byChain,
            active_chains: getActiveChains(),
        });
    }
    catch (e) {
        return c.json({ total_tokens: 0, by_chain: {}, error: e.message });
    }
});
// GET /config - Return chain configurations (public info only)
app.get('/config', (c) => {
    const publicConfig = Object.fromEntries(Object.keys(CHAIN_CONFIGS).map(chain => [
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
    ]));
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
        const contracts = await sql `
      SELECT chain, contract_name, address, deployed_at, deploy_tx_hash, notes, created_at 
      FROM contract_addresses 
      WHERE chain = ${chain}
      ORDER BY contract_name
    `;
        // Also return as object keyed by contract_name for easy lookup
        const addresses = {};
        for (const contract of contracts) {
            addresses[contract.contract_name] = contract.address;
        }
        return c.json({
            chain,
            contracts,
            addresses
        });
    }
    catch (e) {
        console.error('Error fetching contracts:', e.message);
        return c.json({ error: e.message, contracts: [] }, 500);
    }
});
// ============================================
// START SERVER
// ============================================
console.log(`🚀 Starting server on port ${PORT}...`);
// Initial RPC health check
checkAllRpcHealth().then(() => {
    console.log('📡 Initial RPC health check complete');
});
serve({
    fetch: app.fetch,
    port: PORT
}, (info) => {
    console.log(`✅ Server listening on http://localhost:${info.port}`);
    console.log(`📋 Active chains: ${getActiveChains().join(', ') || 'none'}`);
});

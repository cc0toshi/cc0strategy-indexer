import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import 'dotenv/config';
import { getTokens, getTokenByAddress, getSwapsForToken, getOHLCV, sql } from '../db/index.js';

const app = new Hono();

// Verification payment recipient address
const VERIFICATION_RECIPIENT = '0x58e510F849e38095375a3e478ad1d719650b8557'.toLowerCase();
const VERIFICATION_AMOUNT_WEI = BigInt('100000000000000000'); // 0.1 ETH in wei

// Alchemy/RPC helper for verifying transactions
async function verifyTransaction(txHash: string, chain: string = 'base'): Promise<{
  valid: boolean;
  from?: string;
  to?: string;
  value?: bigint;
  error?: string;
}> {
  try {
    const alchemyApiKey = process.env.ALCHEMY_API_KEY;
    if (!alchemyApiKey) {
      return { valid: false, error: 'Alchemy API key not configured' };
    }
    
    const rpcUrl = chain === 'ethereum' 
      ? `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`
      : `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
    
    // Get transaction receipt to check if confirmed
    const receiptResponse = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    });
    
    const receiptData = await receiptResponse.json();
    if (!receiptData.result) {
      return { valid: false, error: 'Transaction not found or not confirmed' };
    }
    
    if (receiptData.result.status !== '0x1') {
      return { valid: false, error: 'Transaction failed' };
    }
    
    // Get full transaction details
    const txResponse = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_getTransactionByHash',
        params: [txHash],
      }),
    });
    
    const txData = await txResponse.json();
    if (!txData.result) {
      return { valid: false, error: 'Transaction details not found' };
    }
    
    const { from, to, value } = txData.result;
    return {
      valid: true,
      from: from?.toLowerCase(),
      to: to?.toLowerCase(),
      value: value ? BigInt(value) : 0n,
    };
  } catch (e: any) {
    return { valid: false, error: e.message || 'Failed to verify transaction' };
  }
}

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

// POST /tokens/verify - Verify a token with payment proof
app.post('/tokens/verify', async (c) => {
  try {
    const body = await c.req.json();
    const { tokenAddress, email, twitter, website, txHash } = body;
    
    // Validate required fields
    if (!tokenAddress || !txHash) {
      return c.json({ error: 'Missing required fields: tokenAddress, txHash' }, 400);
    }
    
    // Get the token from database
    const token = await getTokenByAddress(tokenAddress);
    if (!token) {
      return c.json({ error: 'Token not found' }, 404);
    }
    
    // Check if already verified
    if (token.is_verified) {
      return c.json({ error: 'Token is already verified' }, 400);
    }
    
    // Determine chain from token
    const chain = token.chain || 'base';
    
    // Verify the transaction
    const txVerification = await verifyTransaction(txHash, chain);
    if (!txVerification.valid) {
      return c.json({ error: txVerification.error || 'Invalid transaction' }, 400);
    }
    
    // Check if transaction was sent to the correct address
    if (txVerification.to !== VERIFICATION_RECIPIENT) {
      return c.json({ 
        error: `Transaction must be sent to ${VERIFICATION_RECIPIENT}`,
        got: txVerification.to
      }, 400);
    }
    
    // Check if the value is at least 0.1 ETH
    if (!txVerification.value || txVerification.value < VERIFICATION_AMOUNT_WEI) {
      return c.json({ 
        error: 'Transaction must send at least 0.1 ETH',
        got: txVerification.value?.toString()
      }, 400);
    }
    
    // Check if the sender matches the token deployer
    const deployer = token.deployer?.toLowerCase();
    if (txVerification.from !== deployer) {
      return c.json({ 
        error: 'Transaction must be sent from the token deployer address',
        expected: deployer,
        got: txVerification.from
      }, 400);
    }
    
    // All checks passed - update the token
    await sql`
      UPDATE tokens 
      SET 
        is_verified = true,
        deployer_email = ${email || null},
        deployer_twitter = ${twitter || null},
        deployer_website = ${website || null},
        verified_at = NOW()
      WHERE address = ${tokenAddress.toLowerCase()}
    `;
    
    return c.json({ 
      success: true, 
      message: 'Token verified successfully',
      tokenAddress: tokenAddress.toLowerCase()
    });
    
  } catch (e: any) {
    console.error('Verification error:', e);
    return c.json({ error: e.message || 'Verification failed' }, 500);
  }
});

// GET /tokens/:address/verify-status - Get verification status for a token
app.get('/tokens/:address/verify-status', async (c) => {
  const address = c.req.param('address');
  
  const result = await sql`
    SELECT is_verified, verified_at
    FROM tokens
    WHERE address = ${address.toLowerCase()}
  `;
  
  if (!result || result.length === 0) {
    return c.json({ error: 'Token not found' }, 404);
  }
  
  return c.json({
    isVerified: result[0].is_verified || false,
    verifiedAt: result[0].verified_at || null
  });
});

const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 API server starting on port ${port}`);

serve({ fetch: app.fetch, port });

export default app;

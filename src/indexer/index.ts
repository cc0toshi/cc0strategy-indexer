import { createPublicClient, http, parseAbiItem, decodeEventLog, type Log, type Address } from 'viem';
import { base } from 'viem/chains';
import 'dotenv/config';
import { insertToken, getIndexerState, updateIndexerState, sql } from '../db/index.js';

// Contract addresses
const FACTORY_ADDRESS = '0x70b17db500Ce1746BB34f908140d0279C183f3eb' as Address;
const START_BLOCK = 26700000n;

// Correct event signature per task
const TokenDeployedEvent = parseAbiItem(
  'event TokenDeployed(address indexed token, address indexed nftCollection, bytes32 poolId, address deployer)'
);

// ERC20 ABI for fetching token details
const erc20Abi = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

// Create viem client with Alchemy
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const rpcUrl = ALCHEMY_API_KEY 
  ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`
  : 'https://mainnet.base.org';

const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

// Fetch token metadata from contract
async function fetchTokenMetadata(tokenAddress: Address) {
  try {
    const [name, symbol, decimals] = await Promise.all([
      client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'decimals' }),
    ]);
    return { name, symbol, decimals };
  } catch (e) {
    console.warn(`Failed to fetch metadata for ${tokenAddress}:`, e);
    return { name: 'Unknown', symbol: 'UNKNOWN', decimals: 18 };
  }
}

// Process TokenDeployed event
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
    
    console.log(`📦 TokenDeployed: ${token}`);
    console.log(`   NFT Collection: ${nftCollection}`);
    console.log(`   Pool ID: ${poolId}`);
    console.log(`   Deployer: ${deployer}`);
    console.log(`   Block: ${log.blockNumber}`);
    console.log(`   TX: ${log.transactionHash}`);
    
    // Get block timestamp
    const block = await client.getBlock({ blockNumber: log.blockNumber! });
    
    // Fetch token metadata
    const metadata = await fetchTokenMetadata(token);
    
    // Insert into database
    await insertToken({
      address: token.toLowerCase(),
      name: metadata.name,
      symbol: metadata.symbol,
      decimals: metadata.decimals,
      nftCollection: nftCollection.toLowerCase(),
      nftCollectionName: undefined,
      poolAddress: undefined,
      poolId: poolId,
      deployer: deployer.toLowerCase(),
      deployedAt: new Date(Number(block.timestamp) * 1000),
      deployTxHash: log.transactionHash!,
      deployBlock: log.blockNumber!,
      description: undefined,
      imageUrl: undefined,
      websiteUrl: undefined,
      twitterUrl: undefined,
      isVerified: false,
    });
    
    console.log(`✅ Token inserted: ${metadata.symbol} (${token})`);
  } catch (e: any) {
    if (e.message?.includes('unique constraint')) {
      console.log(`⏭️  Token already exists, skipping`);
    } else {
      console.error('Error handling TokenDeployed:', e);
    }
  }
}

// Backfill historical events
async function backfill() {
  console.log('🔄 Starting backfill...');
  
  const state = await getIndexerState('factory');
  let fromBlock = state?.lastBlock || START_BLOCK;
  const currentBlock = await client.getBlockNumber();
  
  console.log(`📊 From block ${fromBlock} to ${currentBlock}`);
  
  const batchSize = 10000n;
  let totalFound = 0;
  
  while (fromBlock < currentBlock) {
    const toBlock = fromBlock + batchSize > currentBlock ? currentBlock : fromBlock + batchSize;
    
    console.log(`🔍 Scanning blocks ${fromBlock} - ${toBlock}...`);
    
    try {
      const logs = await client.getLogs({
        address: FACTORY_ADDRESS,
        event: TokenDeployedEvent,
        fromBlock,
        toBlock,
      });
      
      if (logs.length > 0) {
        console.log(`   Found ${logs.length} events`);
        totalFound += logs.length;
        
        for (const log of logs) {
          await handleTokenDeployed(log);
        }
      }
      
      // Update state
      await updateIndexerState('factory', toBlock);
      fromBlock = toBlock + 1n;
    } catch (e: any) {
      console.error(`Error fetching logs:`, e.message);
      // Reduce batch size on error
      if (batchSize > 1000n) {
        console.log('Reducing batch size...');
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  console.log(`✅ Backfill complete. Found ${totalFound} tokens.`);
}

// Watch for new events
async function watch() {
  console.log('👀 Watching for new events...');
  
  // Poll every 30 seconds for new blocks
  setInterval(async () => {
    try {
      const state = await getIndexerState('factory');
      const lastBlock = state?.lastBlock || START_BLOCK;
      const currentBlock = await client.getBlockNumber();
      
      if (currentBlock > lastBlock) {
        console.log(`🔍 Checking blocks ${lastBlock + 1n} - ${currentBlock}`);
        
        const logs = await client.getLogs({
          address: FACTORY_ADDRESS,
          event: TokenDeployedEvent,
          fromBlock: lastBlock + 1n,
          toBlock: currentBlock,
        });
        
        for (const log of logs) {
          await handleTokenDeployed(log);
        }
        
        await updateIndexerState('factory', currentBlock);
      }
    } catch (e) {
      console.error('Watch error:', e);
    }
  }, 30000);
}

// Schedule periodic indexer run (every 5 minutes as per task)
function scheduleIndexer() {
  const FIVE_MINUTES = 5 * 60 * 1000;
  
  console.log('⏰ Scheduling indexer to run every 5 minutes');
  
  setInterval(async () => {
    console.log('🔄 Running scheduled index...');
    await backfill();
  }, FIVE_MINUTES);
}

// Main
async function main() {
  console.log('🚀 cc0strategy Indexer Starting...');
  console.log(`📍 Factory: ${FACTORY_ADDRESS}`);
  console.log(`🔗 RPC: ${rpcUrl.replace(ALCHEMY_API_KEY || '', '***')}`);
  
  // Run initial backfill
  await backfill();
  
  // Start watching for new events
  watch();
  
  // Schedule periodic runs
  scheduleIndexer();
  
  console.log('✅ Indexer running');
}

main().catch(console.error);

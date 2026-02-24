/**
 * cc0strategy Multi-Chain Configuration
 * 
 * This file contains all contract addresses and chain-specific configuration.
 * Update Ethereum addresses once contracts are deployed.
 */

export type SupportedChain = 'base' | 'ethereum';

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcEnvKey: string;
  
  // cc0strategy contracts
  factory: string | null;
  hook: string | null;
  feeDistributor: string | null;
  lpLocker: string | null;
  treasury: string;
  
  // Uniswap V4 contracts
  poolManager: string;
  universalRouter: string;
  positionManager: string;
  permit2: string;
  weth: string;
}

export const CHAIN_CONFIGS: Record<SupportedChain, ChainConfig> = {
  base: {
    chainId: 8453,
    name: 'Base Mainnet',
    rpcEnvKey: 'BASE_RPC_URL',
    
    // cc0strategy contracts (LIVE)
    factory: '0x70b17db500Ce1746BB34f908140d0279C183f3eb',
    hook: '0x18aD8c9b72D33E69d8f02fDA61e3c7fAe4e728cc',
    feeDistributor: '0x9Ce2AB2769CcB547aAcE963ea4493001275CD557',
    lpLocker: '0x45e1D9bb68E514565710DEaf2567B73EF86638e0',
    treasury: '0x58e510f849e38095375a3e478ad1d719650b8557',
    
    // Uniswap V4 contracts
    poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
    positionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    weth: '0x4200000000000000000000000000000000000006',
  },
  
  ethereum: {
    chainId: 1,
    name: 'Ethereum Mainnet',
    rpcEnvKey: 'ETH_RPC_URL',
    
    // cc0strategy contracts (DEPLOYED 2026-02-24)
    // 
    factory: '0x45e1D9bb68E514565710DEaf2567B73EF86638e0',
    hook: '0x9f4A65977FbE6ACb9Eee50cEf8319c397C8628cC',
    feeDistributor: '0xDe6DBe5957B617fda4b2dcA4dd45a32B87a54BfE',
    lpLocker: '0xF07807dD09830fea3Cef171054E28519Be0113BA',
    treasury: '0x58e510f849e38095375a3e478ad1d719650b8557', // Same as Base
    
    // Uniswap V4 contracts (ready for deployment)
    poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    universalRouter: '0x66a9893cC07D91D95644AEDD05D03f95e1dba8Af',
    positionManager: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
};

/**
 * Events to index (for future event indexing)
 * 
 * Factory Events:
 * - TokenDeployed(address indexed token, address indexed nftCollection, address deployer)
 * 
 * FeeDistributor Events:
 * - FeesReceived(address indexed token, uint256 amount)
 * - FeesClaimed(address indexed token, address indexed claimer, uint256[] tokenIds, uint256 amount)
 */
export const INDEXED_EVENTS = {
  factory: [
    {
      name: 'TokenDeployed',
      signature: 'TokenDeployed(address,address,address)',
      topic: '0x...', // To be filled with actual topic hash
    },
  ],
  feeDistributor: [
    {
      name: 'FeesReceived',
      signature: 'FeesReceived(address,uint256)',
      topic: '0x...',
    },
    {
      name: 'FeesClaimed', 
      signature: 'FeesClaimed(address,address,uint256[],uint256)',
      topic: '0x...',
    },
  ],
};

/**
 * Get chain config by name
 */
export function getChainConfig(chain: string): ChainConfig | null {
  const normalized = chain.toLowerCase() as SupportedChain;
  return CHAIN_CONFIGS[normalized] || null;
}

/**
 * Get RPC URL for a chain from environment
 */
export function getRpcUrl(chain: SupportedChain): string | undefined {
  const config = CHAIN_CONFIGS[chain];
  return process.env[config.rpcEnvKey];
}

/**
 * Check if a chain has deployed cc0strategy contracts
 */
export function isChainActive(chain: SupportedChain): boolean {
  const config = CHAIN_CONFIGS[chain];
  return config.factory !== null && config.feeDistributor !== null;
}

/**
 * Get all active chains (with deployed contracts)
 */
export function getActiveChains(): SupportedChain[] {
  return (Object.keys(CHAIN_CONFIGS) as SupportedChain[]).filter(isChainActive);
}

/**
 * Validate chain parameter from API
 */
export function validateChain(chain: string | undefined): chain is SupportedChain {
  if (!chain) return false;
  return chain === 'base' || chain === 'ethereum';
}

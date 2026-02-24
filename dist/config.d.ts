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
    factory: string | null;
    hook: string | null;
    feeDistributor: string | null;
    lpLocker: string | null;
    treasury: string;
    poolManager: string;
    universalRouter: string;
    positionManager: string;
    permit2: string;
    weth: string;
}
export declare const CHAIN_CONFIGS: Record<SupportedChain, ChainConfig>;
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
export declare const INDEXED_EVENTS: {
    factory: {
        name: string;
        signature: string;
        topic: string;
    }[];
    feeDistributor: {
        name: string;
        signature: string;
        topic: string;
    }[];
};
/**
 * Get chain config by name
 */
export declare function getChainConfig(chain: string): ChainConfig | null;
/**
 * Get RPC URL for a chain from environment
 */
export declare function getRpcUrl(chain: SupportedChain): string | undefined;
/**
 * Check if a chain has deployed cc0strategy contracts
 */
export declare function isChainActive(chain: SupportedChain): boolean;
/**
 * Get all active chains (with deployed contracts)
 */
export declare function getActiveChains(): SupportedChain[];
/**
 * Validate chain parameter from API
 */
export declare function validateChain(chain: string | undefined): chain is SupportedChain;

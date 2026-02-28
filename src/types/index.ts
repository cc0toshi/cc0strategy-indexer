// cc0strategy Indexer Types

export interface Token {
  id: string;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  nftCollection: string;
  nftCollectionName?: string;
  poolAddress?: string;
  poolId?: string;
  deployer: string;
  deployedAt: Date;
  deployTxHash: string;
  deployBlock: bigint;
  description?: string;
  imageUrl?: string;
  websiteUrl?: string;
  twitterUrl?: string;
  // Verification fields
  isVerified: boolean;
  deployerEmail?: string;
  deployerTwitter?: string;
  deployerWebsite?: string;
  verifiedAt?: Date;
}

export interface Swap {
  id: string;
  tokenAddress: string;
  trader: string;
  isBuy: boolean;
  amountIn: string;
  amountOut: string;
  amountInEth?: string;
  priceEth: string;
  priceUsd?: number;
  txHash: string;
  blockNumber: bigint;
  blockTimestamp: Date;
  logIndex: number;
}

export interface Fee {
  id: string;
  tokenAddress: string;
  feeAmount: string;
  feeToken: string;
  feeAmountUsd?: number;
  totalNfts: number;
  feePerNft: string;
  txHash: string;
  blockNumber: bigint;
  blockTimestamp: Date;
  logIndex: number;
}

export interface Claim {
  id: string;
  tokenAddress: string;
  claimer: string;
  tokenIds: number[];
  amount: string;
  claimToken: string;
  txHash: string;
  blockNumber: bigint;
  blockTimestamp: Date;
  logIndex: number;
}

export interface TokenStats {
  tokenAddress: string;
  volume24h: string;
  volume7d: string;
  volumeTotal: string;
  trades24h: number;
  tradesTotal: number;
  uniqueTraders: number;
  tvl: string;
  liquidityEth: string;
  liquidityToken: string;
  priceEth: string;
  priceUsd?: number;
  priceChange24h?: number;
  athPriceEth?: string;
  atlPriceEth?: string;
  totalFeesDistributed: string;
  totalFeesClaimed: string;
  pendingFees: string;
  marketCapEth?: string;
  fullyDilutedValuation?: string;
  lastTradeAt?: Date;
  lastUpdated: Date;
}

export interface OHLCV {
  tokenAddress: string;
  interval: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  bucketStart: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  tradeCount: number;
}

export interface IndexerState {
  id: string;
  lastBlock: bigint;
  lastUpdated: Date;
}

export interface TokenWithStats extends Token {
  stats?: TokenStats;
}

export interface PendingReward {
  tokenAddress: string;
  tokenSymbol: string;
  nftCollection: string;
  pendingAmount: string;
  tokenIds: number[];
}

export interface WalletRewards {
  wallet: string;
  rewards: PendingReward[];
  totalPendingEth: string;
}

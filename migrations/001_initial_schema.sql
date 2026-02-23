-- cc0strategy Indexer Database Schema
-- Run with: psql $DATABASE_URL -f migrations/001_initial_schema.sql

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- TOKENS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    address VARCHAR(42) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 18,
    nft_collection VARCHAR(42) NOT NULL,
    nft_collection_name VARCHAR(255),
    pool_address VARCHAR(42),
    pool_id BYTEA,
    deployer VARCHAR(42) NOT NULL,
    deployed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    deploy_tx_hash VARCHAR(66) NOT NULL,
    deploy_block BIGINT NOT NULL,
    description TEXT,
    image_url TEXT,
    website_url TEXT,
    twitter_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_tokens_nft_collection ON tokens(nft_collection);
CREATE INDEX idx_tokens_deployer ON tokens(deployer);
CREATE INDEX idx_tokens_deployed_at ON tokens(deployed_at DESC);

-- ============================================
-- SWAPS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS swaps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_address VARCHAR(42) NOT NULL REFERENCES tokens(address),
    trader VARCHAR(42) NOT NULL,
    is_buy BOOLEAN NOT NULL,
    amount_in VARCHAR(78) NOT NULL,
    amount_out VARCHAR(78) NOT NULL,
    amount_in_eth VARCHAR(78),
    price_eth VARCHAR(78) NOT NULL,
    price_usd DECIMAL(36, 18),
    tx_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    block_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    log_index INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tx_hash, log_index)
);

CREATE INDEX idx_swaps_token ON swaps(token_address);
CREATE INDEX idx_swaps_trader ON swaps(trader);
CREATE INDEX idx_swaps_block ON swaps(block_number DESC);
CREATE INDEX idx_swaps_timestamp ON swaps(block_timestamp DESC);
CREATE INDEX idx_swaps_token_timestamp ON swaps(token_address, block_timestamp DESC);

-- ============================================
-- FEES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS fees (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_address VARCHAR(42) NOT NULL REFERENCES tokens(address),
    fee_amount VARCHAR(78) NOT NULL,
    fee_token VARCHAR(42) NOT NULL,
    fee_amount_usd DECIMAL(36, 18),
    total_nfts INTEGER NOT NULL,
    fee_per_nft VARCHAR(78) NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    block_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    log_index INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tx_hash, log_index)
);

CREATE INDEX idx_fees_token ON fees(token_address);
CREATE INDEX idx_fees_timestamp ON fees(block_timestamp DESC);

-- ============================================
-- CLAIMS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_address VARCHAR(42) NOT NULL REFERENCES tokens(address),
    claimer VARCHAR(42) NOT NULL,
    token_ids INTEGER[] NOT NULL,
    amount VARCHAR(78) NOT NULL,
    claim_token VARCHAR(42) NOT NULL,
    tx_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,
    block_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    log_index INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tx_hash, log_index)
);

CREATE INDEX idx_claims_token ON claims(token_address);
CREATE INDEX idx_claims_claimer ON claims(claimer);
CREATE INDEX idx_claims_timestamp ON claims(block_timestamp DESC);

-- ============================================
-- TOKEN_STATS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS token_stats (
    token_address VARCHAR(42) PRIMARY KEY REFERENCES tokens(address),
    volume_24h VARCHAR(78) DEFAULT '0',
    volume_7d VARCHAR(78) DEFAULT '0',
    volume_total VARCHAR(78) DEFAULT '0',
    trades_24h INTEGER DEFAULT 0,
    trades_total INTEGER DEFAULT 0,
    unique_traders INTEGER DEFAULT 0,
    tvl VARCHAR(78) DEFAULT '0',
    liquidity_eth VARCHAR(78) DEFAULT '0',
    liquidity_token VARCHAR(78) DEFAULT '0',
    price_eth VARCHAR(78) DEFAULT '0',
    price_usd DECIMAL(36, 18),
    price_change_24h DECIMAL(10, 4),
    ath_price_eth VARCHAR(78),
    atl_price_eth VARCHAR(78),
    total_fees_distributed VARCHAR(78) DEFAULT '0',
    total_fees_claimed VARCHAR(78) DEFAULT '0',
    pending_fees VARCHAR(78) DEFAULT '0',
    market_cap_eth VARCHAR(78),
    fully_diluted_valuation VARCHAR(78),
    last_trade_at TIMESTAMP WITH TIME ZONE,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- OHLCV TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS ohlcv (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    token_address VARCHAR(42) NOT NULL REFERENCES tokens(address),
    interval VARCHAR(10) NOT NULL,
    bucket_start TIMESTAMP WITH TIME ZONE NOT NULL,
    open VARCHAR(78) NOT NULL,
    high VARCHAR(78) NOT NULL,
    low VARCHAR(78) NOT NULL,
    close VARCHAR(78) NOT NULL,
    volume VARCHAR(78) NOT NULL,
    trade_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(token_address, interval, bucket_start)
);

CREATE INDEX idx_ohlcv_token_interval_bucket ON ohlcv(token_address, interval, bucket_start DESC);

-- ============================================
-- INDEXER_STATE TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS indexer_state (
    id VARCHAR(50) PRIMARY KEY,
    last_block BIGINT NOT NULL DEFAULT 0,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO indexer_state (id, last_block) VALUES 
    ('factory', 0),
    ('swaps', 0),
    ('fee_distributor', 0)
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- TRIGGERS
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tokens_updated_at BEFORE UPDATE ON tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER token_stats_updated_at BEFORE UPDATE ON token_stats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER ohlcv_updated_at BEFORE UPDATE ON ohlcv
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

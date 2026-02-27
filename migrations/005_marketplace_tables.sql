-- Migration 005: Marketplace Tables for NFT Trading
-- Created: 2026-02-27

-- Enable UUID extension if not exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Active marketplace listings (Seaport orders)
CREATE TABLE IF NOT EXISTS marketplace_listings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_hash VARCHAR(66) NOT NULL UNIQUE,
    order_data JSONB NOT NULL,
    
    collection_address VARCHAR(42) NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    seller VARCHAR(42) NOT NULL,
    price_wei VARCHAR(78) NOT NULL,
    currency VARCHAR(42) NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
    
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    filled_at TIMESTAMP,
    filled_by VARCHAR(42),
    filled_tx_hash VARCHAR(66),
    
    chain VARCHAR(20) NOT NULL DEFAULT 'base'
);

CREATE INDEX IF NOT EXISTS idx_listings_collection ON marketplace_listings(collection_address, status);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON marketplace_listings(seller, status);
CREATE INDEX IF NOT EXISTS idx_listings_status ON marketplace_listings(status, end_time);
CREATE INDEX IF NOT EXISTS idx_listings_token ON marketplace_listings(collection_address, token_id);
CREATE INDEX IF NOT EXISTS idx_listings_chain ON marketplace_listings(chain, status);

-- Offers (bids) on NFTs
CREATE TABLE IF NOT EXISTS marketplace_offers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_hash VARCHAR(66) NOT NULL UNIQUE,
    order_data JSONB NOT NULL,
    
    collection_address VARCHAR(42) NOT NULL,
    token_id VARCHAR(78),
    offerer VARCHAR(42) NOT NULL,
    amount_wei VARCHAR(78) NOT NULL,
    
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    accepted_at TIMESTAMP,
    accepted_by VARCHAR(42),
    accepted_tx_hash VARCHAR(66),
    
    chain VARCHAR(20) NOT NULL DEFAULT 'base'
);

CREATE INDEX IF NOT EXISTS idx_offers_collection ON marketplace_offers(collection_address, status);
CREATE INDEX IF NOT EXISTS idx_offers_token ON marketplace_offers(collection_address, token_id, status);
CREATE INDEX IF NOT EXISTS idx_offers_offerer ON marketplace_offers(offerer, status);

-- Activity log
CREATE TABLE IF NOT EXISTS marketplace_activity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(20) NOT NULL,
    
    collection_address VARCHAR(42) NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    
    from_address VARCHAR(42),
    to_address VARCHAR(42),
    price_wei VARCHAR(78),
    tx_hash VARCHAR(66),
    
    timestamp TIMESTAMP NOT NULL,
    chain VARCHAR(20) NOT NULL DEFAULT 'base'
);

CREATE INDEX IF NOT EXISTS idx_activity_collection ON marketplace_activity(collection_address, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_token ON marketplace_activity(collection_address, token_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON marketplace_activity(event_type, timestamp DESC);

-- Collection stats cache
CREATE TABLE IF NOT EXISTS marketplace_collection_stats (
    collection_address VARCHAR(42) NOT NULL,
    chain VARCHAR(20) NOT NULL DEFAULT 'base',
    
    floor_price_wei VARCHAR(78),
    listed_count INTEGER DEFAULT 0,
    volume_24h_wei VARCHAR(78) DEFAULT '0',
    volume_total_wei VARCHAR(78) DEFAULT '0',
    sales_24h INTEGER DEFAULT 0,
    
    updated_at TIMESTAMP DEFAULT NOW(),
    
    PRIMARY KEY (collection_address, chain)
);

CREATE INDEX IF NOT EXISTS idx_tokens_nft_collection ON tokens(nft_collection);

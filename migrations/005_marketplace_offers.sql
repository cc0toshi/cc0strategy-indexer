-- Marketplace Offers/Bids table
-- Stores WETH offers placed via Seaport

CREATE TABLE IF NOT EXISTS marketplace_offers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_hash VARCHAR(66) UNIQUE NOT NULL,
    collection_address VARCHAR(42) NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    offerer VARCHAR(42) NOT NULL,
    amount_wei VARCHAR(78) NOT NULL,  -- WETH amount
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,
    order_data JSONB,
    signature TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',  -- active, filled, cancelled, expired
    filled_at TIMESTAMP WITH TIME ZONE,
    filled_by VARCHAR(42),
    filled_tx_hash VARCHAR(66),
    chain VARCHAR(20) NOT NULL DEFAULT 'base',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_offers_collection_token ON marketplace_offers(collection_address, token_id);
CREATE INDEX IF NOT EXISTS idx_offers_collection_status ON marketplace_offers(collection_address, status);
CREATE INDEX IF NOT EXISTS idx_offers_offerer ON marketplace_offers(offerer);
CREATE INDEX IF NOT EXISTS idx_offers_chain_status ON marketplace_offers(chain, status);
CREATE INDEX IF NOT EXISTS idx_offers_end_time ON marketplace_offers(end_time);

-- Ensure marketplace_activity table exists with proper structure
CREATE TABLE IF NOT EXISTS marketplace_activity (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type VARCHAR(20) NOT NULL,  -- sale, listing, offer, cancel, transfer
    collection_address VARCHAR(42) NOT NULL,
    token_id VARCHAR(78) NOT NULL,
    from_address VARCHAR(42),
    to_address VARCHAR(42),
    price_wei VARCHAR(78),
    tx_hash VARCHAR(66),
    block_number BIGINT,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    chain VARCHAR(20) NOT NULL DEFAULT 'base',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for activity feed
CREATE INDEX IF NOT EXISTS idx_activity_collection_time ON marketplace_activity(collection_address, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_token ON marketplace_activity(collection_address, token_id);
CREATE INDEX IF NOT EXISTS idx_activity_chain_time ON marketplace_activity(chain, timestamp DESC);

-- Ensure collection stats table has all needed fields
CREATE TABLE IF NOT EXISTS marketplace_collection_stats (
    collection_address VARCHAR(42) NOT NULL,
    chain VARCHAR(20) NOT NULL DEFAULT 'base',
    name VARCHAR(255),
    image_url TEXT,
    floor_price_wei VARCHAR(78),
    min_bid_wei VARCHAR(78),
    total_volume_wei VARCHAR(78),
    volume_24h_wei VARCHAR(78),
    volume_total_wei VARCHAR(78),
    holder_count INTEGER,
    listed_count INTEGER,
    sales_24h INTEGER,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (collection_address, chain)
);

-- Add min_bid_wei column if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'marketplace_collection_stats' AND column_name = 'min_bid_wei'
    ) THEN
        ALTER TABLE marketplace_collection_stats ADD COLUMN min_bid_wei VARCHAR(78);
    END IF;
END $$;

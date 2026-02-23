-- Migration 002: Add chain field to tokens table
-- Run with: psql $DATABASE_URL -f migrations/002_add_chain_field.sql

-- Add chain column (base or ethereum)
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS chain VARCHAR(20) NOT NULL DEFAULT 'base';

-- Create index for chain lookups
CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens(chain);

-- Backfill DICKSTR as base (it's already on Base)
UPDATE tokens SET chain = 'base' WHERE chain IS NULL OR chain = '';

-- Log the migration
INSERT INTO indexer_state (id, last_block) VALUES ('migration_002', 1)
ON CONFLICT (id) DO UPDATE SET last_updated = NOW();

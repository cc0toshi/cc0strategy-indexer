-- Migration: Add token verification fields
-- Allows token deployers to verify their tokens for a 0.1 ETH fee

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS deployer_email VARCHAR(255);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS deployer_twitter VARCHAR(255);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS deployer_website VARCHAR(255);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE;

-- Index for filtering verified tokens
CREATE INDEX IF NOT EXISTS idx_tokens_is_verified ON tokens(is_verified);

COMMENT ON COLUMN tokens.is_verified IS 'Whether the token has been verified by the deployer';
COMMENT ON COLUMN tokens.deployer_email IS 'Contact email provided during verification';
COMMENT ON COLUMN tokens.deployer_twitter IS 'Twitter handle provided during verification';
COMMENT ON COLUMN tokens.deployer_website IS 'Website URL provided during verification';
COMMENT ON COLUMN tokens.verified_at IS 'Timestamp when the token was verified';

-- Add social link fields to tokens table
-- Run with: psql $DATABASE_URL -f migrations/004_add_social_links.sql

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS telegram_url TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS discord_url TEXT;

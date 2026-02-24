-- Migration 003: Contract addresses table for multi-chain support
-- Run with: psql $DATABASE_URL -f migrations/003_contract_addresses.sql

CREATE TABLE IF NOT EXISTS contract_addresses (
    id SERIAL PRIMARY KEY,
    chain VARCHAR(20) NOT NULL,
    contract_name VARCHAR(50) NOT NULL,
    address VARCHAR(42) NOT NULL,
    deployed_at TIMESTAMP WITH TIME ZONE,
    deploy_tx_hash VARCHAR(66),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(chain, contract_name)
);

-- Create index for chain lookups
CREATE INDEX IF NOT EXISTS idx_contract_addresses_chain ON contract_addresses(chain);

-- Insert Base mainnet addresses
INSERT INTO contract_addresses (chain, contract_name, address, notes) VALUES
('base', 'factory', '0x70b17db500Ce1746BB34f908140d0279C183f3eb', 'Token deployment'),
('base', 'hook', '0x18aD8c9b72D33E69d8f02fDA61e3c7fAe4e728cc', '1% fee capture'),
('base', 'fee_distributor', '0x9Ce2AB2769CcB547aAcE963ea4493001275CD557', '80/10/10 split'),
('base', 'lp_locker', '0x45e1D9bb68E514565710DEaf2567B73EF86638e0', 'Fee collection'),
('base', 'pool_manager', '0x498581fF718922c3f8e6A244956aF099B2652b2b', 'Uniswap V4'),
('base', 'universal_router', '0x6fF5693b99212Da76ad316178A184AB56D299b43', 'Uniswap V4'),
('base', 'position_manager', '0x7C5f5A4bBd8fD63184577525326123B519429bDc', 'Uniswap V4'),
('base', 'permit2', '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Token approvals'),
('base', 'weth', '0x4200000000000000000000000000000000000006', 'Wrapped ETH')
ON CONFLICT (chain, contract_name) DO UPDATE SET address = EXCLUDED.address;

-- Insert Ethereum mainnet addresses (external contracts only - our contracts TBD)
INSERT INTO contract_addresses (chain, contract_name, address, notes) VALUES
('ethereum', 'pool_manager', '0x000000000004444c5dc75cB358380D2e3dE08A90', 'Uniswap V4'),
('ethereum', 'universal_router', '0x66a9893cC07D91D95644AEDD05D03f95e1dba8Af', 'Uniswap V4'),
('ethereum', 'position_manager', '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', 'Uniswap V4'),
('ethereum', 'permit2', '0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Token approvals'),
('ethereum', 'weth', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'Wrapped ETH')
ON CONFLICT (chain, contract_name) DO UPDATE SET address = EXCLUDED.address;

-- Log the migration
INSERT INTO indexer_state (id, last_block) VALUES ('migration_003', 1)
ON CONFLICT (id) DO UPDATE SET last_updated = NOW();

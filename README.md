# cc0strategy Indexer

Backend indexer and API for the cc0strategy protocol.

**Supported Chains:** Base Mainnet (live), Ethereum Mainnet (pending)

## Quick Start

```bash
# Install dependencies
npm install

# Copy env file
cp .env.example .env
# Edit .env with your settings

# Run migrations
npm run migrate

# Start server
npm run dev
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check with multi-chain RPC status |
| `GET /health` | Service health status |
| `GET /tokens` | List all tokens (with optional chain filter) |
| `GET /tokens/:address` | Token details with chain info |
| `POST /tokens` | Register new token |
| `GET /stats` | Protocol stats with per-chain breakdown |
| `GET /config` | Chain configurations and contract addresses |

## Query Parameters

### GET /tokens
- `chain`: `base` | `ethereum` (optional, filters by chain)
- `limit`: number (default: 50, max: 100)
- `offset`: number (default: 0)

## Environment Variables

```bash
# Database (required)
DATABASE_URL=postgresql://user:password@host:5432/cc0strategy

# Multi-chain RPC URLs
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# Server
PORT=3000
```

## Multi-Chain Configuration

Contract addresses are stored in `src/config.ts`:

```typescript
// Base Mainnet (LIVE)
factory: '0x70b17db500Ce1746BB34f908140d0279C183f3eb'
hook: '0x18aD8c9b72D33E69d8f02fDA61e3c7fAe4e728cc'
feeDistributor: '0x9Ce2AB2769CcB547aAcE963ea4493001275CD557'
lpLocker: '0x45e1D9bb68E514565710DEaf2567B73EF86638e0'

// Ethereum Mainnet (PENDING)
// Update config.ts when contracts are deployed
```

## Event Indexing (Future)

The indexer is prepared to listen for these events:

**Factory Events:**
- `TokenDeployed(address indexed token, address indexed nftCollection, address deployer)`

**FeeDistributor Events:**
- `FeesReceived(address indexed token, uint256 amount)`
- `FeesClaimed(address indexed token, address indexed claimer, uint256[] tokenIds, uint256 amount)`

Implementation pending - structure is in place in `src/index.ts`.

## Database Schema

PostgreSQL with the following tables:
- `tokens` - Deployed strategy tokens (includes `chain` field)

The `chain` field supports: `'base'` | `'ethereum'`

## Project Structure

```
cc0strategy-indexer/
├── migrations/          # SQL migrations
│   ├── 001_initial_schema.sql
│   └── 002_add_chain_field.sql
├── src/
│   ├── index.ts        # Main API server
│   └── config.ts       # Multi-chain configuration
├── .env.example
└── package.json
```

## Deployment

Hosted on Railway with auto-deploy from GitHub.

**Production URL:** https://cc0strategy-indexer-production.up.railway.app

## Adding Ethereum Support

When Ethereum contracts are deployed:

1. Update `src/config.ts` with new addresses:
   ```typescript
   ethereum: {
     factory: '0x...',
     hook: '0x...',
     feeDistributor: '0x...',
     lpLocker: '0x...',
   }
   ```

2. Add `ETH_RPC_URL` to Railway environment variables

3. Push to GitHub - Railway auto-deploys

The API will automatically recognize the new chain as active.

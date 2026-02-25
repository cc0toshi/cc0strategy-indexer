# cc0strategy Indexer

Backend indexer and API for the cc0strategy protocol.

**Supported Chains:** Base Mainnet (live), Ethereum Mainnet (live)

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
// Base Mainnet (LIVE - V2)
factory: '0xDbbC0A64fFe2a23b4543b0731CF61ef0d5d4E265'
hook: '0x5eE3602f499cFEAa4E13D27b4F7D2661906b28cC'
feeDistributor: '0x498bcfdbd724989fc37259faba75168c8f47080d'
lpLocker: '0x5821e651D6fBF096dB3cBD9a21FaE4F5A1E2620A'

// Ethereum Mainnet (LIVE - V2)
factory: '0x1dc68bc05ecb132059fb45b281dbfa92b6fab610'
hook: '0xEfd2F889eD9d7A2Bf6B6C9c2b20c5AEb6EBEe8Cc'
feeDistributor: '0xdcfb59f2d41c58a1325b270c2f402c1884338d0d'
lpLocker: '0x05492c0091e49374e71c93e74739d3f650b59077'
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

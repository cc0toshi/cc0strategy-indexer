# cc0strategy Indexer

Backend indexer and API for the cc0strategy protocol on Base.

## Quick Start

```bash
# Install dependencies
npm install

# Copy env file
cp .env.example .env
# Edit .env with your settings

# Run migrations
npm run migrate

# Start (API + Indexer)
npm run dev

# Or run separately
npm run api       # Just API on port 3000
npm run indexer   # Just event listener
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /tokens` | List all tokens (sortable by volume, tvl, deployed_at) |
| `GET /tokens/:address` | Token details + stats |
| `GET /tokens/:address/swaps` | Recent trades |
| `GET /tokens/:address/chart` | OHLCV candlestick data |
| `GET /rewards/:wallet` | Pending NFT holder rewards |
| `GET /stats` | Global protocol stats |

## Query Parameters

### GET /tokens
- `sort`: `deployed_at` | `volume_24h` | `tvl` (default: deployed_at)
- `order`: `asc` | `desc` (default: desc)
- `limit`: number (default: 50)
- `offset`: number (default: 0)

### GET /tokens/:address/chart
- `interval`: `1m` | `5m` | `15m` | `1h` | `4h` | `1d` (default: 1h)
- `limit`: number (default: 100)

## Database

PostgreSQL with the following tables:
- `tokens` - Deployed strategy tokens
- `swaps` - All swap events
- `fees` - Fee distribution events
- `claims` - NFT holder claims
- `token_stats` - Aggregated metrics
- `ohlcv` - Candlestick data
- `indexer_state` - Indexer progress

## Project Structure

```
cc0strategy-indexer/
├── migrations/          # SQL migrations
├── src/
│   ├── api/            # Hono API routes
│   ├── db/             # Database queries
│   ├── indexer/        # Event listeners
│   ├── types/          # TypeScript types
│   └── utils/          # Helpers
├── .env.example
└── package.json
```

## Environment Variables

```
DATABASE_URL=postgresql://user:password@localhost:5432/cc0strategy
BASE_RPC_URL=https://mainnet.base.org
BASE_WS_URL=wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY
FACTORY_ADDRESS=0x...
FEE_DISTRIBUTOR_ADDRESS=0x...
PORT=3000
START_BLOCK=0
```

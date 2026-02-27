// Marketplace API Routes for cc0strategy
import { Hono } from 'hono';
import type postgres from 'postgres';

const TREASURY = '0x58e510f849e38095375a3e478ad1d719650b8557';
const PLATFORM_FEE_BPS = 100; // 1%
const SEAPORT_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395';

type Sql = ReturnType<typeof postgres>;

export function createMarketplaceRoutes(sql: Sql | null) {
  const marketplace = new Hono();

  // ============================================
  // LISTINGS API
  // ============================================

  // GET /marketplace/listings - Get all active listings
  marketplace.get('/listings', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const collection = c.req.query('collection')?.toLowerCase();
      const seller = c.req.query('seller')?.toLowerCase();
      const chain = c.req.query('chain') || 'base';
      const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
      const offset = parseInt(c.req.query('offset') || '0');
      const sortBy = c.req.query('sort') || 'price_asc';

      // Build query based on filters
      let listings;
      const orderBy = sortBy === 'price_desc' ? 'ORDER BY CAST(price_wei AS NUMERIC) DESC' : 
                      sortBy === 'newest' ? 'ORDER BY created_at DESC' :
                      'ORDER BY CAST(price_wei AS NUMERIC) ASC';

      if (collection && seller) {
        listings = await sql.unsafe(`
          SELECT * FROM marketplace_listings 
          WHERE collection_address = $1 AND seller = $2 AND status = 'active' AND chain = $3
          AND end_time > NOW()
          ${orderBy}
          LIMIT $4 OFFSET $5
        `, [collection, seller, chain, limit, offset]);
      } else if (collection) {
        listings = await sql.unsafe(`
          SELECT * FROM marketplace_listings 
          WHERE collection_address = $1 AND status = 'active' AND chain = $2
          AND end_time > NOW()
          ${orderBy}
          LIMIT $3 OFFSET $4
        `, [collection, chain, limit, offset]);
      } else if (seller) {
        listings = await sql.unsafe(`
          SELECT * FROM marketplace_listings 
          WHERE seller = $1 AND status = 'active' AND chain = $2
          AND end_time > NOW()
          ${orderBy}
          LIMIT $3 OFFSET $4
        `, [seller, chain, limit, offset]);
      } else {
        listings = await sql.unsafe(`
          SELECT * FROM marketplace_listings 
          WHERE status = 'active' AND chain = $1
          AND end_time > NOW()
          ${orderBy}
          LIMIT $2 OFFSET $3
        `, [chain, limit, offset]);
      }

      return c.json({
        listings: listings,
        pagination: { limit, offset },
        filter: { collection, seller, chain, sortBy }
      });
    } catch (e: any) {
      console.error('Error fetching listings:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // GET /marketplace/listings/:orderHash - Get single listing
  marketplace.get('/listings/:orderHash', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const orderHash = c.req.param('orderHash').toLowerCase();
      const [listing] = await sql`
        SELECT * FROM marketplace_listings WHERE order_hash = ${orderHash}
      `;

      if (!listing) {
        return c.json({ error: 'Listing not found' }, 404);
      }

      return c.json(listing);
    } catch (e: any) {
      console.error('Error fetching listing:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /marketplace/listings - Create new listing
  marketplace.post('/listings', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const body = await c.req.json();
      const {
        orderHash,
        orderData,
        collectionAddress,
        tokenId,
        seller,
        priceWei,
        currency = '0x0000000000000000000000000000000000000000',
        startTime,
        endTime,
        chain = 'base'
      } = body;

      if (!orderHash || !orderData || !collectionAddress || !tokenId || !seller || !priceWei) {
        return c.json({ error: 'Missing required fields' }, 400);
      }

      const [listing] = await sql`
        INSERT INTO marketplace_listings (
          order_hash, order_data, collection_address, token_id, seller,
          price_wei, currency, start_time, end_time, chain
        ) VALUES (
          ${orderHash.toLowerCase()},
          ${JSON.stringify(orderData)},
          ${collectionAddress.toLowerCase()},
          ${tokenId},
          ${seller.toLowerCase()},
          ${priceWei},
          ${currency.toLowerCase()},
          ${new Date(startTime * 1000)},
          ${new Date(endTime * 1000)},
          ${chain}
        )
        ON CONFLICT (order_hash) DO UPDATE SET
          status = 'active',
          price_wei = EXCLUDED.price_wei,
          end_time = EXCLUDED.end_time
        RETURNING *
      `;

      // Log activity
      await sql`
        INSERT INTO marketplace_activity (
          event_type, collection_address, token_id, from_address, price_wei, chain, timestamp
        ) VALUES (
          'listing', ${collectionAddress.toLowerCase()}, ${tokenId}, 
          ${seller.toLowerCase()}, ${priceWei}, ${chain}, NOW()
        )
      `;

      console.log(`📝 New listing: ${collectionAddress} #${tokenId} for ${priceWei} wei`);
      return c.json(listing);
    } catch (e: any) {
      console.error('Error creating listing:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /marketplace/listings/:orderHash/fill - Mark listing as filled
  marketplace.post('/listings/:orderHash/fill', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const orderHash = c.req.param('orderHash').toLowerCase();
      const body = await c.req.json();
      const { filledBy, txHash } = body;

      const [listing] = await sql`
        UPDATE marketplace_listings 
        SET status = 'filled', filled_at = NOW(), filled_by = ${filledBy?.toLowerCase()}, filled_tx_hash = ${txHash}
        WHERE order_hash = ${orderHash}
        RETURNING *
      `;

      if (!listing) {
        return c.json({ error: 'Listing not found' }, 404);
      }

      // Log sale activity
      await sql`
        INSERT INTO marketplace_activity (
          event_type, collection_address, token_id, from_address, to_address, 
          price_wei, tx_hash, chain, timestamp
        ) VALUES (
          'sale', ${listing.collection_address}, ${listing.token_id}, 
          ${listing.seller}, ${filledBy?.toLowerCase()}, ${listing.price_wei},
          ${txHash}, ${listing.chain}, NOW()
        )
      `;

      console.log(`💰 Sale: ${listing.collection_address} #${listing.token_id} sold for ${listing.price_wei} wei`);
      return c.json(listing);
    } catch (e: any) {
      console.error('Error filling listing:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /marketplace/listings/:orderHash/cancel - Cancel listing
  marketplace.post('/listings/:orderHash/cancel', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const orderHash = c.req.param('orderHash').toLowerCase();

      const [listing] = await sql`
        UPDATE marketplace_listings 
        SET status = 'cancelled'
        WHERE order_hash = ${orderHash}
        RETURNING *
      `;

      if (!listing) {
        return c.json({ error: 'Listing not found' }, 404);
      }

      console.log(`❌ Cancelled listing: ${listing.collection_address} #${listing.token_id}`);
      return c.json(listing);
    } catch (e: any) {
      console.error('Error cancelling listing:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // ============================================
  // COLLECTIONS API
  // ============================================

  // GET /marketplace/collections - Get all collections with listings
  marketplace.get('/collections', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const chain = c.req.query('chain') || 'base';

      // Get linked collections from tokens table
      const collections = await sql`
        SELECT DISTINCT 
          t.nft_collection as address,
          t.nft_collection_name as name,
          t.symbol as token_symbol,
          t.address as token_address,
          t.chain,
          COALESCE(s.floor_price_wei, '0') as floor_price_wei,
          COALESCE(s.listed_count, 0) as listed_count,
          COALESCE(s.volume_24h_wei, '0') as volume_24h_wei,
          COALESCE(s.volume_total_wei, '0') as volume_total_wei
        FROM tokens t
        LEFT JOIN marketplace_collection_stats s ON 
          t.nft_collection = s.collection_address AND t.chain = s.chain
        WHERE t.chain = ${chain} 
          AND t.nft_collection != '0x0000000000000000000000000000000000000000'
        ORDER BY COALESCE(s.volume_24h_wei, '0') DESC
      `;

      return c.json({ collections, chain });
    } catch (e: any) {
      console.error('Error fetching collections:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // GET /marketplace/collections/:address - Get collection details
  marketplace.get('/collections/:address', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const address = c.req.param('address').toLowerCase();
      const chain = c.req.query('chain') || 'base';

      // Get linked token
      const [token] = await sql`
        SELECT * FROM tokens 
        WHERE nft_collection = ${address} AND chain = ${chain}
      `;

      // Get stats
      const [stats] = await sql`
        SELECT * FROM marketplace_collection_stats 
        WHERE collection_address = ${address} AND chain = ${chain}
      `;

      // Get floor listing
      const [floorListing] = await sql`
        SELECT * FROM marketplace_listings 
        WHERE collection_address = ${address} AND chain = ${chain} 
          AND status = 'active' AND end_time > NOW()
        ORDER BY CAST(price_wei AS NUMERIC) ASC
        LIMIT 1
      `;

      // Get listing count
      const [listingCount] = await sql`
        SELECT COUNT(*) as count FROM marketplace_listings 
        WHERE collection_address = ${address} AND chain = ${chain} 
          AND status = 'active' AND end_time > NOW()
      `;

      return c.json({
        address,
        chain,
        token: token || null,
        stats: stats || { floor_price_wei: '0', listed_count: 0, volume_24h_wei: '0' },
        floorListing: floorListing || null,
        listedCount: parseInt(listingCount?.count || '0')
      });
    } catch (e: any) {
      console.error('Error fetching collection:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // ============================================
  // ACTIVITY API
  // ============================================

  // GET /marketplace/activity - Get activity feed
  marketplace.get('/activity', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const collection = c.req.query('collection')?.toLowerCase();
      const tokenId = c.req.query('tokenId');
      const chain = c.req.query('chain') || 'base';
      const eventType = c.req.query('type'); // sale, listing, offer, transfer
      const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
      const offset = parseInt(c.req.query('offset') || '0');

      let activity;
      if (collection && tokenId) {
        activity = await sql`
          SELECT * FROM marketplace_activity 
          WHERE collection_address = ${collection} AND token_id = ${tokenId} AND chain = ${chain}
          ${eventType ? sql`AND event_type = ${eventType}` : sql``}
          ORDER BY timestamp DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (collection) {
        activity = await sql`
          SELECT * FROM marketplace_activity 
          WHERE collection_address = ${collection} AND chain = ${chain}
          ${eventType ? sql`AND event_type = ${eventType}` : sql``}
          ORDER BY timestamp DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        activity = await sql`
          SELECT * FROM marketplace_activity 
          WHERE chain = ${chain}
          ${eventType ? sql`AND event_type = ${eventType}` : sql``}
          ORDER BY timestamp DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return c.json({
        activity,
        pagination: { limit, offset },
        filter: { collection, tokenId, chain, eventType }
      });
    } catch (e: any) {
      console.error('Error fetching activity:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // ============================================
  // SEAPORT HELPERS
  // ============================================

  // GET /marketplace/seaport/config - Get Seaport config
  marketplace.get('/seaport/config', (c) => {
    return c.json({
      seaportAddress: SEAPORT_ADDRESS,
      treasury: TREASURY,
      platformFeeBps: PLATFORM_FEE_BPS,
      conduitKey: '0x0000000000000000000000000000000000000000000000000000000000000000',
      zones: {
        base: '0x0000000000000000000000000000000000000000',
        ethereum: '0x0000000000000000000000000000000000000000'
      }
    });
  });

  // POST /marketplace/seaport/validate-order - Validate a Seaport order
  marketplace.post('/seaport/validate-order', async (c) => {
    try {
      const body = await c.req.json();
      const { orderParameters, signature } = body;

      // Basic validation
      if (!orderParameters || !signature) {
        return c.json({ valid: false, error: 'Missing orderParameters or signature' }, 400);
      }

      // Check offer items (should have 1 ERC721)
      const offer = orderParameters.offer || [];
      if (offer.length !== 1 || offer[0].itemType !== 2) {
        return c.json({ valid: false, error: 'Invalid offer: must be single ERC721' });
      }

      // Check consideration (should have seller payment + platform fee)
      const consideration = orderParameters.consideration || [];
      if (consideration.length < 2) {
        return c.json({ valid: false, error: 'Missing platform fee in consideration' });
      }

      // Check platform fee recipient
      const platformFee = consideration.find((c: any) => 
        c.recipient?.toLowerCase() === TREASURY.toLowerCase()
      );
      if (!platformFee) {
        return c.json({ valid: false, error: 'Platform fee must go to treasury' });
      }

      return c.json({ 
        valid: true,
        seaportAddress: SEAPORT_ADDRESS,
        orderHash: orderParameters.orderHash || null
      });
    } catch (e: any) {
      console.error('Order validation error:', e);
      return c.json({ valid: false, error: e.message }, 500);
    }
  });

  // ============================================
  // STATS
  // ============================================

  // GET /marketplace/stats - Get marketplace stats
  marketplace.get('/stats', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const chain = c.req.query('chain') || 'base';

      const [listingStats] = await sql`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'active' AND end_time > NOW()) as active_listings,
          COUNT(*) FILTER (WHERE status = 'filled') as total_sales,
          COALESCE(SUM(CAST(price_wei AS NUMERIC)) FILTER (WHERE status = 'filled'), 0) as total_volume_wei
        FROM marketplace_listings
        WHERE chain = ${chain}
      `;

      const [recentVolume] = await sql`
        SELECT COALESCE(SUM(CAST(price_wei AS NUMERIC)), 0) as volume_24h_wei
        FROM marketplace_listings
        WHERE chain = ${chain} AND status = 'filled' AND filled_at > NOW() - INTERVAL '24 hours'
      `;

      return c.json({
        chain,
        activeListings: parseInt(listingStats?.active_listings || '0'),
        totalSales: parseInt(listingStats?.total_sales || '0'),
        totalVolumeWei: listingStats?.total_volume_wei?.toString() || '0',
        volume24hWei: recentVolume?.volume_24h_wei?.toString() || '0'
      });
    } catch (e: any) {
      console.error('Error fetching marketplace stats:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /marketplace/collections/:address/refresh-stats - Refresh collection stats
  marketplace.post('/collections/:address/refresh-stats', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const address = c.req.param('address').toLowerCase();
      const chain = c.req.query('chain') || 'base';

      // Calculate stats
      const [stats] = await sql`
        SELECT 
          MIN(CAST(price_wei AS NUMERIC)) FILTER (WHERE status = 'active' AND end_time > NOW()) as floor_price,
          COUNT(*) FILTER (WHERE status = 'active' AND end_time > NOW()) as listed_count,
          COALESCE(SUM(CAST(price_wei AS NUMERIC)) FILTER (WHERE status = 'filled' AND filled_at > NOW() - INTERVAL '24 hours'), 0) as volume_24h,
          COALESCE(SUM(CAST(price_wei AS NUMERIC)) FILTER (WHERE status = 'filled'), 0) as volume_total,
          COUNT(*) FILTER (WHERE status = 'filled' AND filled_at > NOW() - INTERVAL '24 hours') as sales_24h
        FROM marketplace_listings
        WHERE collection_address = ${address} AND chain = ${chain}
      `;

      // Upsert stats
      await sql`
        INSERT INTO marketplace_collection_stats (
          collection_address, chain, floor_price_wei, listed_count, 
          volume_24h_wei, volume_total_wei, sales_24h, updated_at
        ) VALUES (
          ${address}, ${chain}, 
          ${stats.floor_price?.toString() || null},
          ${parseInt(stats.listed_count || '0')},
          ${stats.volume_24h?.toString() || '0'},
          ${stats.volume_total?.toString() || '0'},
          ${parseInt(stats.sales_24h || '0')},
          NOW()
        )
        ON CONFLICT (collection_address, chain) DO UPDATE SET
          floor_price_wei = EXCLUDED.floor_price_wei,
          listed_count = EXCLUDED.listed_count,
          volume_24h_wei = EXCLUDED.volume_24h_wei,
          volume_total_wei = EXCLUDED.volume_total_wei,
          sales_24h = EXCLUDED.sales_24h,
          updated_at = NOW()
      `;

      return c.json({ success: true, stats });
    } catch (e: any) {
      console.error('Error refreshing stats:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  return marketplace;
}

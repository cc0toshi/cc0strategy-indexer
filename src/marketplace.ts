// Marketplace API Routes for cc0strategy
import { Hono } from 'hono';
import type postgres from 'postgres';
import { randomBytes } from 'crypto';

const TREASURY = '0x58e510f849e38095375a3e478ad1d719650b8557';
const PLATFORM_FEE_BPS = 100; // 1%
const SEAPORT_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395';

type Sql = ReturnType<typeof postgres>;

// Generate a random order hash if not provided
function generateOrderHash(): string {
  return '0x' + randomBytes(32).toString('hex');
}

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

      // Validate platform fee in order data
      const orderParams = orderData.parameters || orderData;
      const consideration = orderParams.consideration || [];
      const platformFeeItem = consideration.find((c: any) => 
        c.recipient?.toLowerCase() === TREASURY.toLowerCase()
      );
      
      if (!platformFeeItem) {
        return c.json({ error: `Platform fee required. Fee must go to: ${TREASURY}` }, 400);
      }
      
      // Verify 1% fee
      const feeAmount = BigInt(platformFeeItem.startAmount || '0');
      const totalPrice = BigInt(priceWei);
      const expectedFee = totalPrice / 100n;
      const tolerance = totalPrice / 10000n; // 0.01% tolerance
      
      if (feeAmount < expectedFee - tolerance) {
        return c.json({ 
          error: `Insufficient platform fee. Expected 1% (${expectedFee.toString()}), got ${feeAmount.toString()}`
        }, 400);
      }
      
      console.log(`✅ Listing validated: ${collectionAddress} #${tokenId}, price: ${priceWei}, fee: ${feeAmount.toString()}`);

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
  // OFFERS/BIDS API
  // ============================================

  // GET /marketplace/offers - Get offers for a collection/token
  marketplace.get('/offers', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const collection = c.req.query('collection')?.toLowerCase();
      const tokenId = c.req.query('tokenId');
      const offerer = c.req.query('offerer')?.toLowerCase();
      const chain = c.req.query('chain') || 'base';
      const status = c.req.query('status') || 'active';
      const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
      const offset = parseInt(c.req.query('offset') || '0');

      let offers;
      if (collection && tokenId) {
        offers = await sql`
          SELECT * FROM marketplace_offers 
          WHERE collection_address = ${collection} AND token_id = ${tokenId} 
            AND chain = ${chain} AND status = ${status}
            AND end_time > NOW()
          ORDER BY CAST(amount_wei AS NUMERIC) DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (collection) {
        offers = await sql`
          SELECT * FROM marketplace_offers 
          WHERE collection_address = ${collection} AND chain = ${chain} AND status = ${status}
            AND end_time > NOW()
          ORDER BY CAST(amount_wei AS NUMERIC) DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else if (offerer) {
        offers = await sql`
          SELECT * FROM marketplace_offers 
          WHERE offerer = ${offerer} AND chain = ${chain} AND status = ${status}
            AND end_time > NOW()
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        offers = await sql`
          SELECT * FROM marketplace_offers 
          WHERE chain = ${chain} AND status = ${status}
            AND end_time > NOW()
          ORDER BY created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return c.json({
        offers,
        pagination: { limit, offset },
        filter: { collection, tokenId, offerer, chain, status }
      });
    } catch (e: any) {
      console.error('Error fetching offers:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // GET /marketplace/offers/:orderHash - Get single offer
  marketplace.get('/offers/:orderHash', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const orderHash = c.req.param('orderHash').toLowerCase();
      const [offer] = await sql`
        SELECT * FROM marketplace_offers WHERE order_hash = ${orderHash}
      `;

      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      return c.json(offer);
    } catch (e: any) {
      console.error('Error fetching offer:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /marketplace/offers - Create new offer/bid
  marketplace.post('/offers', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const body = await c.req.json();
      const {
        collectionAddress,
        tokenId,
        offerer,
        amountWei,
        endTime,
        orderData,
        signature,
        chain = 'base'
      } = body;

      if (!collectionAddress || !tokenId || !offerer || !amountWei || !endTime) {
        return c.json({ error: 'Missing required fields' }, 400);
      }

      // Validate platform fee in order data
      if (orderData) {
        const consideration = orderData.consideration || [];
        const platformFeeItem = consideration.find((c: any) => 
          c.recipient?.toLowerCase() === TREASURY.toLowerCase()
        );
        
        if (!platformFeeItem) {
          return c.json({ error: `Platform fee required. Fee must go to: ${TREASURY}` }, 400);
        }
        
        // Verify 1% fee based on offer amount
        const feeAmount = BigInt(platformFeeItem.startAmount || '0');
        const offerAmount = BigInt(amountWei);
        const expectedFee = offerAmount / 100n;
        const tolerance = offerAmount / 10000n; // 0.01% tolerance
        
        if (feeAmount < expectedFee - tolerance) {
          return c.json({ 
            error: `Insufficient platform fee. Expected 1% (${expectedFee.toString()}), got ${feeAmount.toString()}`
          }, 400);
        }
        
        console.log(`✅ Offer validated: ${collectionAddress} #${tokenId}, amount: ${amountWei}, fee: ${feeAmount.toString()}`);
      }

      // Generate order hash from order data or create one
      const orderHash = generateOrderHash();

      const [offer] = await sql`
        INSERT INTO marketplace_offers (
          order_hash, collection_address, token_id, offerer, amount_wei,
          end_time, order_data, signature, chain, status
        ) VALUES (
          ${orderHash},
          ${collectionAddress.toLowerCase()},
          ${tokenId},
          ${offerer.toLowerCase()},
          ${amountWei},
          ${new Date(endTime * 1000)},
          ${orderData ? JSON.stringify(orderData) : null},
          ${signature || null},
          ${chain},
          'active'
        )
        RETURNING *
      `;

      // Log activity
      await sql`
        INSERT INTO marketplace_activity (
          event_type, collection_address, token_id, from_address, price_wei, chain, timestamp
        ) VALUES (
          'offer', ${collectionAddress.toLowerCase()}, ${tokenId}, 
          ${offerer.toLowerCase()}, ${amountWei}, ${chain}, NOW()
        )
      `;

      console.log(`🤝 New offer: ${collectionAddress} #${tokenId} for ${amountWei} wei WETH`);
      return c.json(offer);
    } catch (e: any) {
      console.error('Error creating offer:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /marketplace/offers/:orderHash/fill - Mark offer as filled (accepted)
  marketplace.post('/offers/:orderHash/fill', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const orderHash = c.req.param('orderHash').toLowerCase();
      const body = await c.req.json();
      const { filledBy, txHash } = body;

      const [offer] = await sql`
        UPDATE marketplace_offers 
        SET status = 'filled', filled_at = NOW(), filled_by = ${filledBy?.toLowerCase()}, filled_tx_hash = ${txHash}
        WHERE order_hash = ${orderHash}
        RETURNING *
      `;

      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      // Log sale activity (offer accepted = sale)
      await sql`
        INSERT INTO marketplace_activity (
          event_type, collection_address, token_id, from_address, to_address, 
          price_wei, tx_hash, chain, timestamp
        ) VALUES (
          'sale', ${offer.collection_address}, ${offer.token_id}, 
          ${filledBy?.toLowerCase()}, ${offer.offerer}, ${offer.amount_wei},
          ${txHash}, ${offer.chain}, NOW()
        )
      `;

      console.log(`✅ Offer accepted: ${offer.collection_address} #${offer.token_id} for ${offer.amount_wei} wei`);
      return c.json(offer);
    } catch (e: any) {
      console.error('Error filling offer:', e);
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /marketplace/offers/:orderHash/cancel - Cancel offer
  marketplace.post('/offers/:orderHash/cancel', async (c) => {
    if (!sql) return c.json({ error: 'Database not configured' }, 500);

    try {
      const orderHash = c.req.param('orderHash').toLowerCase();

      const [offer] = await sql`
        UPDATE marketplace_offers 
        SET status = 'cancelled'
        WHERE order_hash = ${orderHash}
        RETURNING *
      `;

      if (!offer) {
        return c.json({ error: 'Offer not found' }, 404);
      }

      console.log(`❌ Cancelled offer: ${offer.collection_address} #${offer.token_id}`);
      return c.json(offer);
    } catch (e: any) {
      console.error('Error cancelling offer:', e);
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

      // Get min bid
      const [minBid] = await sql`
        SELECT MIN(CAST(amount_wei AS NUMERIC)) as min_bid
        FROM marketplace_offers
        WHERE collection_address = ${address} AND chain = ${chain}
          AND status = 'active' AND end_time > NOW()
      `;

      return c.json({
        address,
        chain,
        token: token || null,
        stats: stats || { floor_price_wei: '0', listed_count: 0, volume_24h_wei: '0' },
        floorListing: floorListing || null,
        listedCount: parseInt(listingCount?.count || '0'),
        minBid: minBid?.min_bid?.toString() || null
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
      conduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
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
      const { orderParameters, signature, orderType = 'listing' } = body;

      // Basic validation
      if (!orderParameters || !signature) {
        return c.json({ valid: false, error: 'Missing orderParameters or signature' }, 400);
      }

      // Check offer items (should have 1 ERC721 for listing, or 1 ERC20 for bid)
      const offer = orderParameters.offer || [];
      if (offer.length !== 1) {
        return c.json({ valid: false, error: 'Invalid offer: must have exactly 1 item' });
      }

      // Check consideration (should have seller payment + platform fee)
      const consideration = orderParameters.consideration || [];
      if (consideration.length < 2) {
        return c.json({ valid: false, error: 'Missing platform fee in consideration. Orders must include 1% platform fee.' });
      }

      // Check platform fee recipient
      const platformFeeItem = consideration.find((c: any) => 
        c.recipient?.toLowerCase() === TREASURY.toLowerCase()
      );
      if (!platformFeeItem) {
        return c.json({ valid: false, error: `Platform fee must go to treasury: ${TREASURY}` });
      }

      // Validate 1% platform fee amount
      // For listings: offer[0] is NFT, consideration[0] is seller payment, consideration[1] is fee
      // For offers: offer[0] is WETH, consideration[0] is NFT, consideration[1] is fee
      const feeAmount = BigInt(platformFeeItem.startAmount || '0');
      
      if (orderType === 'listing') {
        // For listings, total price = sellerReceives + platformFee
        const sellerItem = consideration.find((c: any) => 
          c.recipient?.toLowerCase() !== TREASURY.toLowerCase() && 
          (c.itemType === 0 || c.itemType === 1) // ETH or ERC20
        );
        if (sellerItem) {
          const sellerAmount = BigInt(sellerItem.startAmount || '0');
          const totalPrice = sellerAmount + feeAmount;
          const expectedFee = totalPrice / 100n; // 1%
          
          // Allow small rounding tolerance (within 0.01% of total)
          const tolerance = totalPrice / 10000n;
          if (feeAmount < expectedFee - tolerance || feeAmount > expectedFee + tolerance) {
            return c.json({ 
              valid: false, 
              error: `Platform fee must be exactly 1%. Expected: ${expectedFee.toString()}, Got: ${feeAmount.toString()}`
            });
          }
        }
      } else if (orderType === 'offer') {
        // For offers, offer amount is the WETH being offered
        const offerAmount = BigInt(offer[0]?.startAmount || '0');
        const expectedFee = offerAmount / 100n; // 1%
        
        const tolerance = offerAmount / 10000n;
        if (feeAmount < expectedFee - tolerance || feeAmount > expectedFee + tolerance) {
          return c.json({ 
            valid: false, 
            error: `Platform fee must be exactly 1%. Expected: ${expectedFee.toString()}, Got: ${feeAmount.toString()}`
          });
        }
      }

      return c.json({ 
        valid: true,
        seaportAddress: SEAPORT_ADDRESS,
        treasury: TREASURY,
        platformFeeBps: PLATFORM_FEE_BPS,
        feeAmount: feeAmount.toString(),
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

      const [offerStats] = await sql`
        SELECT COUNT(*) as active_offers
        FROM marketplace_offers
        WHERE chain = ${chain} AND status = 'active' AND end_time > NOW()
      `;

      return c.json({
        chain,
        activeListings: parseInt(listingStats?.active_listings || '0'),
        activeOffers: parseInt(offerStats?.active_offers || '0'),
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

  // ============================================
  // OPENSEA API PROXY
  // ============================================

  const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || '';
  const OPENSEA_CHAINS: Record<string, string> = {
    ethereum: 'ethereum',
    base: 'base',
  };

  // GET /marketplace/opensea/listings/:collection - Get listings from OpenSea
  marketplace.get('/opensea/listings/:collection', async (c) => {
    const collection = c.req.param('collection').toLowerCase();
    const chain = c.req.query('chain') || 'ethereum';
    const limit = Math.min(parseInt(c.req.query('limit') || '100'), 100);

    if (!OPENSEA_API_KEY) {
      return c.json({ error: 'OpenSea API key not configured', listings: {} }, 500);
    }

    const chainSlug = OPENSEA_CHAINS[chain] || 'ethereum';

    try {
      // First get collection slug from contract address
      const contractUrl = `https://api.opensea.io/api/v2/chain/${chainSlug}/contract/${collection}`;
      const contractRes = await fetch(contractUrl, {
        headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY },
      });
      
      let collectionSlug = collection;
      if (contractRes.ok) {
        const contractData = await contractRes.json();
        collectionSlug = contractData.collection || collection;
      }
      
      // Use the listings/collection endpoint for best listings
      const url = `https://api.opensea.io/api/v2/listings/collection/${collectionSlug}/best?limit=${limit}`;

      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'x-api-key': OPENSEA_API_KEY,
        },
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`OpenSea listings error ${response.status}:`, errText);
        let errorDetail = `OpenSea API error: ${response.status}`;
        try {
          const errJson = JSON.parse(errText);
          errorDetail = errJson.errors?.[0] || errJson.detail || errJson.message || errorDetail;
        } catch {}
        return c.json({ error: errorDetail, listings: {}, debug: { url, status: response.status } }, 500 as const);
      }

      const data = await response.json();
      
      // Convert to a map of tokenId -> listing
      const listings: Record<string, any> = {};
      
      // The /listings/collection/{slug}/best endpoint returns { listings: [...] }
      const listingsArray = data.listings || data.orders || [];
      
      for (const listing of listingsArray) {
        // Get token ID from the listing
        const tokenId = listing.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria ||
                        listing.criteria?.trait?.token_ids?.[0] ||
                        listing.token_id;
        
        if (tokenId) {
          listings[tokenId] = {
            orderHash: listing.order_hash,
            price: listing.price?.current?.value || '0',
            currency: listing.price?.current?.currency || 'ETH',
            decimals: listing.price?.current?.decimals || 18,
            seller: listing.maker?.address || listing.offerer,
            expiration: listing.expiration_date,
            protocolAddress: listing.protocol_address,
            orderData: listing.protocol_data?.parameters || null,
            signature: listing.protocol_data?.signature || '',
          };
        }
      }

      return c.json({ 
        listings, 
        count: Object.keys(listings).length, 
        chain,
        collectionSlug,
        debug: { totalListings: listingsArray.length, parsedListings: Object.keys(listings).length }
      });
    } catch (e: any) {
      console.error('OpenSea listings fetch error:', e);
      return c.json({ error: e.message, listings: {} }, 500);
    }
  });

  // GET /marketplace/opensea/events/:collection - Get events/activity from OpenSea
  // Note: :collection can be either a slug (like "mfers") or contract address
  marketplace.get('/opensea/events/:collection', async (c) => {
    const collection = c.req.param('collection');
    const chain = c.req.query('chain') || 'ethereum';
    const eventType = c.req.query('event_type'); // sale, listing, offer, cancel, transfer
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 50);

    if (!OPENSEA_API_KEY) {
      return c.json({ error: 'OpenSea API key not configured', events: [] }, 500);
    }

    try {
      // Determine if collection is a slug or contract address
      const isContractAddress = collection.startsWith('0x') && collection.length === 42;
      
      let url: string;
      if (isContractAddress) {
        // For contract addresses, we need to first get the collection slug
        // Or use the collection events endpoint which accepts contract addresses
        // OpenSea API: GET /api/v2/events/collection/{collection_slug}
        // We need to first lookup the slug from the contract
        const contractUrl = `https://api.opensea.io/api/v2/chain/${OPENSEA_CHAINS[chain] || 'ethereum'}/contract/${collection.toLowerCase()}`;
        const contractRes = await fetch(contractUrl, {
          headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY },
        });
        
        if (!contractRes.ok) {
          return c.json({ error: 'Could not find collection', events: [] }, 404);
        }
        
        const contractData = await contractRes.json();
        const slug = contractData.collection;
        if (!slug) {
          return c.json({ error: 'Collection slug not found', events: [] }, 404);
        }
        
        url = `https://api.opensea.io/api/v2/events/collection/${slug}?limit=${limit}`;
      } else {
        // It's already a slug
        url = `https://api.opensea.io/api/v2/events/collection/${collection}?limit=${limit}`;
      }
      
      if (eventType) {
        url += `&event_type=${eventType}`;
      }

      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'x-api-key': OPENSEA_API_KEY,
        },
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`OpenSea events error ${response.status}:`, errText);
        return c.json({ error: `OpenSea API error: ${response.status}`, events: [] }, 500 as const);
      }

      const data = await response.json();
      
      // Transform events to our format
      const events = (data.asset_events || []).map((event: any) => {
        // For listings/orders, token_id may be in order data, not in nft object
        let tokenId = event.nft?.identifier || null;
        if (!tokenId && event.order) {
          // Try to get from order's offer items
          tokenId = event.order.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria || 
                    event.order.maker_asset_bundle?.assets?.[0]?.token_id || null;
        }
        if (!tokenId && event.criteria) {
          tokenId = event.criteria.trait?.token_ids?.[0] || null;
        }
        
        return {
          id: event.event_type + '-' + (event.order_hash || event.transaction?.transaction_hash || Math.random().toString(36)),
          event_type: mapOpenSeaEventType(event.event_type),
          collection_address: event.nft?.contract || collection,
          token_id: tokenId,
          from_address: event.seller || event.maker || event.from_account?.address || null,
          to_address: event.buyer || event.taker || event.to_account?.address || null,
          price_wei: event.payment?.quantity || event.base_price || null,
          tx_hash: event.transaction?.transaction_hash || null,
          timestamp: event.event_timestamp || new Date().toISOString(),
          block_number: event.transaction?.block_number || null,
          image: event.nft?.image_url || null,
          opensea_link: event.nft?.opensea_url || null,
        };
      });

      return c.json({ events, count: events.length, chain });
    } catch (e: any) {
      console.error('OpenSea events fetch error:', e);
      return c.json({ error: e.message, events: [] }, 500);
    }
  });

  // GET /marketplace/opensea/offers/:collection/:tokenId - Get ALL offers for a specific NFT
  // This includes both item-specific offers AND collection-wide offers that can be accepted
  marketplace.get('/opensea/offers/:collection/:tokenId', async (c) => {
    const collection = c.req.param('collection').toLowerCase();
    const tokenId = c.req.param('tokenId');
    const chain = c.req.query('chain') || 'ethereum';
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50);

    if (!OPENSEA_API_KEY) {
      return c.json({ error: 'OpenSea API key not configured', offers: [] }, 500);
    }

    const chainSlug = OPENSEA_CHAINS[chain] || 'ethereum';

    try {
      // First get collection slug from contract address
      const contractUrl = `https://api.opensea.io/api/v2/chain/${chainSlug}/contract/${collection}`;
      const contractRes = await fetch(contractUrl, {
        headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY },
      });
      
      let collectionSlug = collection;
      if (contractRes.ok) {
        const contractData = await contractRes.json();
        collectionSlug = contractData.collection || collection;
      }

      // Fetch BOTH item-specific offers AND collection-wide offers in parallel
      const [itemOffersRes, collectionOffersRes] = await Promise.all([
        // Item-specific offers for this exact NFT
        fetch(
          `https://api.opensea.io/api/v2/orders/${chainSlug}/seaport/offers?asset_contract_address=${collection}&token_ids=${tokenId}&order_by=eth_price&order_direction=desc&limit=${limit}`,
          { headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY } }
        ),
        // Collection-wide offers that can be accepted for ANY NFT in the collection
        fetch(
          `https://api.opensea.io/api/v2/offers/collection/${collectionSlug}?limit=${limit}`,
          { headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY } }
        ),
      ]);

      const allOffers: any[] = [];

      // Parse item-specific offers
      if (itemOffersRes.ok) {
        const itemData = await itemOffersRes.json();
        for (const order of (itemData.orders || [])) {
          allOffers.push({
            orderHash: order.order_hash,
            price: order.price?.current?.value || '0',
            currency: order.price?.current?.currency || 'WETH',
            decimals: order.price?.current?.decimals || 18,
            offerer: order.maker?.address,
            expiration: order.expiration_date,
            protocolAddress: order.protocol_address,
            orderData: order.protocol_data?.parameters || null,
            signature: order.protocol_data?.signature || '',
            isCollectionOffer: false,
            tokenId: tokenId,
          });
        }
      }

      // Parse collection-wide offers (these can be accepted for this NFT too!)
      if (collectionOffersRes.ok) {
        const collData = await collectionOffersRes.json();
        for (const order of (collData.offers || [])) {
          allOffers.push({
            orderHash: order.order_hash,
            price: order.price?.current?.value || order.price?.value || '0',
            currency: order.price?.current?.currency || order.price?.currency || 'WETH',
            decimals: order.price?.current?.decimals || 18,
            offerer: order.maker?.address || order.protocol_data?.parameters?.offerer,
            expiration: order.expiration_date,
            protocolAddress: order.protocol_address,
            orderData: order.protocol_data?.parameters || null,
            signature: order.protocol_data?.signature || '',
            isCollectionOffer: true,
            tokenId: null, // Applies to any NFT in collection
          });
        }
      }

      // Sort all offers by price descending (highest first)
      allOffers.sort((a, b) => {
        const priceA = BigInt(a.price || '0');
        const priceB = BigInt(b.price || '0');
        return priceB > priceA ? 1 : priceB < priceA ? -1 : 0;
      });

      // Get best offer (highest price)
      const bestOffer = allOffers.length > 0 ? allOffers[0] : null;

      return c.json({ 
        offers: allOffers, 
        count: allOffers.length, 
        tokenId, 
        collection, 
        collectionSlug,
        chain,
        bestOffer,
        itemOffersCount: allOffers.filter(o => !o.isCollectionOffer).length,
        collectionOffersCount: allOffers.filter(o => o.isCollectionOffer).length,
      });
    } catch (e: any) {
      console.error('OpenSea offers fetch error:', e);
      return c.json({ error: e.message, offers: [] }, 500);
    }
  });

  // GET /marketplace/opensea/collection/:slug - Get collection info by slug
  marketplace.get('/opensea/collection/:slug', async (c) => {
    const slug = c.req.param('slug');

    if (!OPENSEA_API_KEY) {
      return c.json({ error: 'OpenSea API key not configured' }, 500);
    }

    try {
      const url = `https://api.opensea.io/api/v2/collections/${slug}`;

      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'x-api-key': OPENSEA_API_KEY,
        },
      });

      if (!response.ok) {
        return c.json({ error: `OpenSea API error: ${response.status}` }, 500 as const);
      }

      const data = await response.json();
      return c.json(data);
    } catch (e: any) {
      console.error('OpenSea collection fetch error:', e);
      return c.json({ error: e.message }, 500 as const);
    }
  });

  // GET /marketplace/opensea/collection-offers/:collection - Get collection offers for minBid
  marketplace.get('/opensea/collection-offers/:collection', async (c) => {
    const collection = c.req.param('collection').toLowerCase();
    const chain = c.req.query('chain') || 'ethereum';
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);

    if (!OPENSEA_API_KEY) {
      return c.json({ error: 'OpenSea API key not configured', offers: [], minBid: null }, 500);
    }

    const chainSlug = OPENSEA_CHAINS[chain] || 'ethereum';

    try {
      // First get collection slug from contract address
      const contractUrl = `https://api.opensea.io/api/v2/chain/${chainSlug}/contract/${collection}`;
      const contractRes = await fetch(contractUrl, {
        headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY },
      });
      
      let collectionSlug = collection;
      if (contractRes.ok) {
        const contractData = await contractRes.json();
        collectionSlug = contractData.collection || collection;
      }

      // Fetch both collection-wide offers AND item-specific offers
      const [collectionOffersRes, itemOffersRes] = await Promise.all([
        // Collection offers endpoint (offers that apply to any NFT in collection)
        fetch(`https://api.opensea.io/api/v2/offers/collection/${collectionSlug}?limit=${limit}`, {
          headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY },
        }),
        // Item-specific offers (for fallback)
        fetch(`https://api.opensea.io/api/v2/orders/${chainSlug}/seaport/offers?asset_contract_address=${collection}&order_by=eth_price&order_direction=asc&limit=${limit}`, {
          headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY },
        }),
      ]);

      const allOffers: any[] = [];

      // Parse collection-wide offers
      if (collectionOffersRes.ok) {
        const collectionData = await collectionOffersRes.json();
        const collectionOffers = collectionData.offers || [];
        
        for (const order of collectionOffers) {
          allOffers.push({
            orderHash: order.order_hash,
            price: order.price?.current?.value || order.price?.value || '0',
            currency: order.price?.current?.currency || order.price?.currency || 'WETH',
            decimals: order.price?.current?.decimals || 18,
            offerer: order.maker?.address || order.protocol_data?.parameters?.offerer,
            tokenId: null, // Collection offer - applies to any NFT
            expiration: order.expiration_date,
            isCollectionOffer: true,
          });
        }
      }

      // Parse item-specific offers
      if (itemOffersRes.ok) {
        const itemData = await itemOffersRes.json();
        const itemOrders = itemData.orders || [];
        
        for (const order of itemOrders) {
          allOffers.push({
            orderHash: order.order_hash,
            price: order.price?.current?.value || '0',
            currency: order.price?.current?.currency || 'WETH',
            decimals: order.price?.current?.decimals || 18,
            offerer: order.maker?.address,
            tokenId: order.protocol_data?.parameters?.consideration?.[0]?.identifierOrCriteria || null,
            expiration: order.expiration_date,
            isCollectionOffer: false,
          });
        }
      }

      // Sort all offers by price (low to high) and get minBid
      allOffers.sort((a, b) => {
        const priceA = BigInt(a.price || '0');
        const priceB = BigInt(b.price || '0');
        return priceA < priceB ? -1 : priceA > priceB ? 1 : 0;
      });

      // Get min bid (lowest offer)
      const minBid = allOffers.length > 0 ? allOffers[0].price : null;

      return c.json({ 
        offers: allOffers, 
        count: allOffers.length, 
        minBid,
        collection, 
        collectionSlug,
        chain,
      });
    } catch (e: any) {
      console.error('OpenSea collection offers fetch error:', e);
      return c.json({ error: e.message, offers: [], minBid: null }, 500);
    }
  });

  // GET /marketplace/opensea/nft-offers-batch - Get best offer for multiple NFTs at once
  marketplace.get('/opensea/nft-offers-batch', async (c) => {
    const collection = c.req.query('collection')?.toLowerCase();
    const tokenIds = c.req.query('tokenIds')?.split(',') || [];
    const chain = c.req.query('chain') || 'ethereum';

    if (!collection || tokenIds.length === 0) {
      return c.json({ error: 'Missing collection or tokenIds', offers: {} }, 400);
    }

    if (!OPENSEA_API_KEY) {
      return c.json({ error: 'OpenSea API key not configured', offers: {} }, 500);
    }

    const chainSlug = OPENSEA_CHAINS[chain] || 'ethereum';
    const offers: Record<string, any> = {};

    try {
      // First get collection slug for collection offers
      const contractUrl = `https://api.opensea.io/api/v2/chain/${chainSlug}/contract/${collection}`;
      const contractRes = await fetch(contractUrl, {
        headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY },
      });
      
      let collectionSlug = collection;
      let collectionOffer: any = null;

      if (contractRes.ok) {
        const contractData = await contractRes.json();
        collectionSlug = contractData.collection || collection;
        
        // Get collection-wide best offer
        const collOffersRes = await fetch(
          `https://api.opensea.io/api/v2/offers/collection/${collectionSlug}?limit=1`,
          { headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY } }
        );
        
        if (collOffersRes.ok) {
          const collData = await collOffersRes.json();
          if (collData.offers?.[0]) {
            const offer = collData.offers[0];
            collectionOffer = {
              orderHash: offer.order_hash,
              price: offer.price?.current?.value || offer.price?.value || '0',
              currency: offer.price?.current?.currency || 'WETH',
              decimals: offer.price?.current?.decimals || 18,
              offerer: offer.maker?.address,
              isCollectionOffer: true,
            };
          }
        }
      }

      // Batch fetch item-specific offers (max 30 tokenIds per request)
      const batchSize = 30;
      for (let i = 0; i < tokenIds.length; i += batchSize) {
        const batch = tokenIds.slice(i, i + batchSize);
        const tokenIdsParam = batch.join(',');
        
        const url = `https://api.opensea.io/api/v2/orders/${chainSlug}/seaport/offers?asset_contract_address=${collection}&token_ids=${tokenIdsParam}&order_by=eth_price&order_direction=desc&limit=100`;
        
        const response = await fetch(url, {
          headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY },
        });

        if (response.ok) {
          const data = await response.json();
          
          // Group offers by tokenId and get best for each
          for (const order of (data.orders || [])) {
            const tokenId = order.protocol_data?.parameters?.consideration?.[0]?.identifierOrCriteria;
            if (!tokenId) continue;

            const offerData = {
              orderHash: order.order_hash,
              price: order.price?.current?.value || '0',
              currency: order.price?.current?.currency || 'WETH',
              decimals: order.price?.current?.decimals || 18,
              offerer: order.maker?.address,
              isCollectionOffer: false,
            };

            // Keep best (highest) offer for each tokenId
            if (!offers[tokenId] || BigInt(offerData.price) > BigInt(offers[tokenId].price)) {
              offers[tokenId] = offerData;
            }
          }
        }
      }

      // For any NFT without item-specific offer, use collection offer if available
      if (collectionOffer) {
        for (const tokenId of tokenIds) {
          if (!offers[tokenId]) {
            offers[tokenId] = { ...collectionOffer, tokenId };
          } else if (BigInt(collectionOffer.price) > BigInt(offers[tokenId].price)) {
            // Collection offer is better
            offers[tokenId] = { ...collectionOffer, tokenId };
          }
        }
      }

      return c.json({ 
        offers, 
        count: Object.keys(offers).length, 
        collection, 
        chain,
        collectionOffer,
      });
    } catch (e: any) {
      console.error('OpenSea batch offers fetch error:', e);
      return c.json({ error: e.message, offers: {} }, 500);
    }
  });


  // POST /marketplace/opensea/fulfill - Get fulfillment data for a listing
  marketplace.post("/opensea/fulfill", async (c) => {
    const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
    if (!OPENSEA_API_KEY) {
      return c.json({ error: "OpenSea API key not configured" }, 500);
    }

    try {
      const body = await c.req.json();
      const { orderHash, chain, fulfiller, protocolAddress } = body;

      if (!orderHash || !fulfiller) {
        return c.json({ error: "Missing orderHash or fulfiller" }, 400);
      }

      const chainSlug = chain === "ethereum" ? "ethereum" : "base";

      // Call OpenSea Fulfillment API
      const url = "https://api.opensea.io/api/v2/listings/fulfillment_data";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "x-api-key": OPENSEA_API_KEY,
        },
        body: JSON.stringify({
          listing: {
            hash: orderHash,
            chain: chainSlug,
            protocol_address: protocolAddress || "0x0000000000000068F116a894984e2DB1123eB395",
          },
          fulfiller: {
            address: fulfiller,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("OpenSea fulfill error:", errText);
        return c.json({ error: "OpenSea API error", details: errText }, 500 as const);
      }

      const data = await response.json();
      
      // Extract transaction data and encode calldata
      const tx = data.fulfillment_data?.transaction;
      if (tx && tx.input_data?.parameters) {
        const params = tx.input_data.parameters;
        
        // Encode the fulfillBasicOrder_efficient_6GL6yc call
        const { encodeFunctionData } = await import('viem');
        
        // Seaport 1.6 ABI for fulfillBasicOrder_efficient_6GL6yc
        const seaportAbi = [{
          name: 'fulfillBasicOrder_efficient_6GL6yc',
          type: 'function',
          inputs: [{
            name: 'parameters',
            type: 'tuple',
            components: [
              { name: 'considerationToken', type: 'address' },
              { name: 'considerationIdentifier', type: 'uint256' },
              { name: 'considerationAmount', type: 'uint256' },
              { name: 'offerer', type: 'address' },
              { name: 'zone', type: 'address' },
              { name: 'offerToken', type: 'address' },
              { name: 'offerIdentifier', type: 'uint256' },
              { name: 'offerAmount', type: 'uint256' },
              { name: 'basicOrderType', type: 'uint8' },
              { name: 'startTime', type: 'uint256' },
              { name: 'endTime', type: 'uint256' },
              { name: 'zoneHash', type: 'bytes32' },
              { name: 'salt', type: 'uint256' },
              { name: 'offererConduitKey', type: 'bytes32' },
              { name: 'fulfillerConduitKey', type: 'bytes32' },
              { name: 'totalOriginalAdditionalRecipients', type: 'uint256' },
              { name: 'additionalRecipients', type: 'tuple[]', components: [
                { name: 'amount', type: 'uint256' },
                { name: 'recipient', type: 'address' }
              ]},
              { name: 'signature', type: 'bytes' }
            ]
          }],
          outputs: [{ name: '', type: 'bool' }]
        }] as const;

        // Format parameters for encoding
        const formattedParams = {
          considerationToken: params.considerationToken as `0x${string}`,
          considerationIdentifier: BigInt(params.considerationIdentifier || '0'),
          considerationAmount: BigInt(params.considerationAmount || '0'),
          offerer: params.offerer as `0x${string}`,
          zone: params.zone as `0x${string}`,
          offerToken: params.offerToken as `0x${string}`,
          offerIdentifier: BigInt(params.offerIdentifier || '0'),
          offerAmount: BigInt(params.offerAmount || '1'),
          basicOrderType: Number(params.basicOrderType || 0),
          startTime: BigInt(params.startTime || '0'),
          endTime: BigInt(params.endTime || '0'),
          zoneHash: params.zoneHash as `0x${string}`,
          salt: BigInt(params.salt || '0'),
          offererConduitKey: params.offererConduitKey as `0x${string}`,
          fulfillerConduitKey: params.fulfillerConduitKey as `0x${string}`,
          totalOriginalAdditionalRecipients: BigInt(params.totalOriginalAdditionalRecipients || '0'),
          additionalRecipients: (params.additionalRecipients || []).map((r: any) => ({
            amount: BigInt(r.amount || '0'),
            recipient: r.recipient as `0x${string}`
          })),
          signature: params.signature as `0x${string}`
        };

        const calldata = encodeFunctionData({
          abi: seaportAbi,
          functionName: 'fulfillBasicOrder_efficient_6GL6yc',
          args: [formattedParams]
        });

        // Return transaction with encoded calldata
        return c.json({
          transaction: {
            to: tx.to,
            value: tx.value,
            data: calldata,
          },
          fulfillment_data: data.fulfillment_data,
        });
      }

      // Fallback: return raw OpenSea response
      return c.json(data);
    } catch (e: any) {
      console.error("Fulfill error:", e);
      return c.json({ error: e.message }, 500);
    }
  });

  // POST /marketplace/opensea/fulfill-offer - Get fulfillment data for accepting an offer
  // This is different from fulfill (for listings) - offers are accepted by the NFT owner
  marketplace.post("/opensea/fulfill-offer", async (c) => {
    const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
    if (!OPENSEA_API_KEY) {
      return c.json({ error: "OpenSea API key not configured" }, 500);
    }

    try {
      const body = await c.req.json();
      const { orderHash, chain, fulfiller, tokenId, collectionAddress, isCollectionOffer } = body;

      if (!orderHash || !fulfiller) {
        return c.json({ error: "Missing orderHash or fulfiller" }, 400);
      }

      const chainSlug = chain === "ethereum" ? "ethereum" : "base";

      // Call OpenSea Offer Fulfillment API
      // For offers, we use /api/v2/offers/fulfillment_data
      const url = "https://api.opensea.io/api/v2/offers/fulfillment_data";
      
      // Build the request body based on whether it's a collection offer or item offer
      const requestBody: any = {
        offer: {
          hash: orderHash,
          chain: chainSlug,
          protocol_address: "0x0000000000000068F116a894984e2DB1123eB395",
        },
        fulfiller: {
          address: fulfiller,
        },
      };

      // For collection offers, we need to specify which NFT we're selling
      if (isCollectionOffer && tokenId && collectionAddress) {
        requestBody.consideration = {
          asset_contract_address: collectionAddress,
          token_id: tokenId,
        };
      }

      console.log(`🔄 Fulfilling offer: ${orderHash}, isCollection: ${isCollectionOffer}, tokenId: ${tokenId}`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "x-api-key": OPENSEA_API_KEY,
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error("OpenSea offer fulfill error:", errText);
        return c.json({ error: "OpenSea API error", details: errText }, 500 as const);
      }

      const data = await response.json();
      
      // Extract transaction data
      const tx = data.fulfillment_data?.transaction;
      if (tx) {
        // OpenSea returns transaction data that may need encoding
        if (tx.input_data?.parameters) {
          const params = tx.input_data.parameters;
          const { encodeFunctionData } = await import('viem');
          
          // Determine which function to use based on the input_data
          const fnName = tx.input_data.function || 'fulfillBasicOrder_efficient_6GL6yc';
          
          // Seaport ABI for basic order fulfillment
          const seaportAbi = [{
            name: 'fulfillBasicOrder_efficient_6GL6yc',
            type: 'function',
            inputs: [{
              name: 'parameters',
              type: 'tuple',
              components: [
                { name: 'considerationToken', type: 'address' },
                { name: 'considerationIdentifier', type: 'uint256' },
                { name: 'considerationAmount', type: 'uint256' },
                { name: 'offerer', type: 'address' },
                { name: 'zone', type: 'address' },
                { name: 'offerToken', type: 'address' },
                { name: 'offerIdentifier', type: 'uint256' },
                { name: 'offerAmount', type: 'uint256' },
                { name: 'basicOrderType', type: 'uint8' },
                { name: 'startTime', type: 'uint256' },
                { name: 'endTime', type: 'uint256' },
                { name: 'zoneHash', type: 'bytes32' },
                { name: 'salt', type: 'uint256' },
                { name: 'offererConduitKey', type: 'bytes32' },
                { name: 'fulfillerConduitKey', type: 'bytes32' },
                { name: 'totalOriginalAdditionalRecipients', type: 'uint256' },
                { name: 'additionalRecipients', type: 'tuple[]', components: [
                  { name: 'amount', type: 'uint256' },
                  { name: 'recipient', type: 'address' }
                ]},
                { name: 'signature', type: 'bytes' }
              ]
            }],
            outputs: [{ name: '', type: 'bool' }]
          }] as const;

          try {
            const formattedParams = {
              considerationToken: params.considerationToken as `0x${string}`,
              considerationIdentifier: BigInt(params.considerationIdentifier || '0'),
              considerationAmount: BigInt(params.considerationAmount || '0'),
              offerer: params.offerer as `0x${string}`,
              zone: params.zone as `0x${string}`,
              offerToken: params.offerToken as `0x${string}`,
              offerIdentifier: BigInt(params.offerIdentifier || '0'),
              offerAmount: BigInt(params.offerAmount || '1'),
              basicOrderType: Number(params.basicOrderType || 0),
              startTime: BigInt(params.startTime || '0'),
              endTime: BigInt(params.endTime || '0'),
              zoneHash: params.zoneHash as `0x${string}`,
              salt: BigInt(params.salt || '0'),
              offererConduitKey: params.offererConduitKey as `0x${string}`,
              fulfillerConduitKey: params.fulfillerConduitKey as `0x${string}`,
              totalOriginalAdditionalRecipients: BigInt(params.totalOriginalAdditionalRecipients || '0'),
              additionalRecipients: (params.additionalRecipients || []).map((r: any) => ({
                amount: BigInt(r.amount || '0'),
                recipient: r.recipient as `0x${string}`
              })),
              signature: params.signature as `0x${string}`
            };

            const calldata = encodeFunctionData({
              abi: seaportAbi,
              functionName: 'fulfillBasicOrder_efficient_6GL6yc',
              args: [formattedParams]
            });

            return c.json({
              transaction: {
                to: tx.to,
                value: tx.value || '0',
                data: calldata,
              },
              fulfillment_data: data.fulfillment_data,
            });
          } catch (encodeError) {
            console.error('Error encoding offer fulfill calldata:', encodeError);
            // Fall through to raw data
          }
        }

        // If we have raw calldata, use it directly
        if (tx.data || tx.input) {
          return c.json({
            transaction: {
              to: tx.to,
              value: tx.value || '0',
              data: tx.data || tx.input,
            },
            fulfillment_data: data.fulfillment_data,
          });
        }
      }

      // Return raw response if we couldn't process it
      return c.json(data);
    } catch (e: any) {
      console.error("Offer fulfill error:", e);
      return c.json({ error: e.message }, 500);
    }
  });

  return marketplace;
}

// Helper to map OpenSea event types to our types
function mapOpenSeaEventType(osType: string): string {
  const typeStr = osType?.toLowerCase() || 'unknown';
  const mapping: Record<string, string> = {
    'sale': 'sale',
    'successful': 'sale',  // OpenSea uses 'successful' for completed sales
    'order': 'listing',
    'listing': 'listing',
    'created': 'listing',  // order_created
    'offer': 'offer',
    'offer_entered': 'offer',
    'bid_entered': 'offer',
    'bid': 'offer',
    'collection_offer': 'offer',
    'cancel': 'cancel',
    'cancelled': 'cancel',
    'order_cancelled': 'cancel',
    'transfer': 'transfer',
    'redemption': 'transfer',
    'mint': 'transfer',
  };
  return mapping[typeStr] || typeStr;
}

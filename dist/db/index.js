import postgres from 'postgres';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/cc0strategy';
export const sql = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
});
export async function insertToken(token) {
    const result = await sql `
    INSERT INTO tokens (
      address, name, symbol, decimals, nft_collection, nft_collection_name,
      pool_address, pool_id, deployer, deployed_at, deploy_tx_hash, deploy_block,
      description, image_url, website_url, twitter_url
    ) VALUES (
      ${token.address}, ${token.name}, ${token.symbol}, ${token.decimals},
      ${token.nftCollection}, ${token.nftCollectionName || null},
      ${token.poolAddress || null}, ${token.poolId || null},
      ${token.deployer}, ${token.deployedAt}, ${token.deployTxHash}, ${token.deployBlock.toString()},
      ${token.description || null}, ${token.imageUrl || null},
      ${token.websiteUrl || null}, ${token.twitterUrl || null}
    )
    RETURNING *
  `;
    return result[0];
}
export async function getTokens(options = {}) {
    const { sortBy = 'deployed_at', order = 'desc', limit = 50, offset = 0 } = options;
    return sql `
    SELECT t.*, ts.*
    FROM tokens t
    LEFT JOIN token_stats ts ON t.address = ts.token_address
    ORDER BY ${sql(sortBy)} ${sql.unsafe(order.toUpperCase())}
    LIMIT ${limit} OFFSET ${offset}
  `;
}
export async function getTokenByAddress(address) {
    const result = await sql `
    SELECT t.*, ts.*
    FROM tokens t
    LEFT JOIN token_stats ts ON t.address = ts.token_address
    WHERE t.address = ${address.toLowerCase()}
  `;
    return result[0] || null;
}
export async function insertSwap(swap) {
    const result = await sql `
    INSERT INTO swaps (
      token_address, trader, is_buy, amount_in, amount_out, amount_in_eth,
      price_eth, price_usd, tx_hash, block_number, block_timestamp, log_index
    ) VALUES (
      ${swap.tokenAddress}, ${swap.trader}, ${swap.isBuy},
      ${swap.amountIn}, ${swap.amountOut}, ${swap.amountInEth || null},
      ${swap.priceEth}, ${swap.priceUsd || null},
      ${swap.txHash}, ${swap.blockNumber.toString()}, ${swap.blockTimestamp}, ${swap.logIndex}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
    RETURNING *
  `;
    return result[0];
}
export async function getSwapsForToken(tokenAddress, limit = 50) {
    return sql `
    SELECT * FROM swaps
    WHERE token_address = ${tokenAddress.toLowerCase()}
    ORDER BY block_timestamp DESC
    LIMIT ${limit}
  `;
}
export async function insertFee(fee) {
    const result = await sql `
    INSERT INTO fees (
      token_address, fee_amount, fee_token, fee_amount_usd,
      total_nfts, fee_per_nft, tx_hash, block_number, block_timestamp, log_index
    ) VALUES (
      ${fee.tokenAddress}, ${fee.feeAmount}, ${fee.feeToken}, ${fee.feeAmountUsd || null},
      ${fee.totalNfts}, ${fee.feePerNft}, ${fee.txHash}, ${fee.blockNumber.toString()},
      ${fee.blockTimestamp}, ${fee.logIndex}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
    RETURNING *
  `;
    return result[0];
}
export async function insertClaim(claim) {
    const result = await sql `
    INSERT INTO claims (
      token_address, claimer, token_ids, amount, claim_token,
      tx_hash, block_number, block_timestamp, log_index
    ) VALUES (
      ${claim.tokenAddress}, ${claim.claimer}, ${claim.tokenIds},
      ${claim.amount}, ${claim.claimToken},
      ${claim.txHash}, ${claim.blockNumber.toString()}, ${claim.blockTimestamp}, ${claim.logIndex}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
    RETURNING *
  `;
    return result[0];
}
export async function getOHLCV(tokenAddress, interval, limit = 100) {
    return sql `
    SELECT * FROM ohlcv
    WHERE token_address = ${tokenAddress.toLowerCase()} AND interval = ${interval}
    ORDER BY bucket_start DESC
    LIMIT ${limit}
  `;
}
export async function getIndexerState(id) {
    const result = await sql `SELECT * FROM indexer_state WHERE id = ${id}`;
    if (!result[0])
        return null;
    return {
        id: result[0].id,
        lastBlock: BigInt(result[0].last_block),
        lastUpdated: result[0].last_updated
    };
}
export async function updateIndexerState(id, lastBlock) {
    await sql `UPDATE indexer_state SET last_block = ${lastBlock.toString()}, last_updated = NOW() WHERE id = ${id}`;
}
export async function updateTokenStats(tokenAddress) {
    await sql `
    INSERT INTO token_stats (token_address) VALUES (${tokenAddress})
    ON CONFLICT (token_address) DO UPDATE SET
      volume_24h = (SELECT COALESCE(SUM(amount_in_eth::numeric), 0)::text FROM swaps WHERE token_address = ${tokenAddress} AND block_timestamp > NOW() - INTERVAL '24 hours'),
      trades_24h = (SELECT COUNT(*) FROM swaps WHERE token_address = ${tokenAddress} AND block_timestamp > NOW() - INTERVAL '24 hours'),
      trades_total = (SELECT COUNT(*) FROM swaps WHERE token_address = ${tokenAddress}),
      total_fees_distributed = (SELECT COALESCE(SUM(fee_amount::numeric), 0)::text FROM fees WHERE token_address = ${tokenAddress}),
      total_fees_claimed = (SELECT COALESCE(SUM(amount::numeric), 0)::text FROM claims WHERE token_address = ${tokenAddress}),
      last_updated = NOW()
  `;
}
export default sql;

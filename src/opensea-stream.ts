// OpenSea Stream API WebSocket Integration
// Docs: https://docs.opensea.io/reference/stream-api-overview
// Using Phoenix Protocol over WebSocket
// NOTE: This is OPTIONAL - the rest of the indexer works without it

import type { Server } from 'socket.io';
import { EventEmitter } from 'events';
import WebSocket from 'ws'; // Node.js WebSocket (default import for ESM)

const OPENSEA_STREAM_URL = 'wss://stream.openseabeta.com/socket/websocket';
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || '';

// Track if stream is available (graceful degradation)
let streamAvailable = false;
let lastStreamError: string | null = null;

// Event types from OpenSea Stream API
export type OpenSeaEventType = 
  | 'item_listed'
  | 'item_sold'
  | 'item_transferred'
  | 'item_cancelled'
  | 'item_received_offer'
  | 'item_received_bid'
  | 'collection_offer';

interface StreamEvent {
  event_type: OpenSeaEventType;
  payload: {
    collection?: { slug: string };
    item?: {
      chain?: { name: string };
      nft_id?: string;
      metadata?: { image_url?: string; name?: string };
      permalink?: string;
    };
    listing_date?: string;
    listing_type?: string;
    maker?: { address: string };
    taker?: { address: string };
    base_price?: string;
    payment_token?: { address: string; symbol: string; decimals: number };
    quantity?: number;
    order_hash?: string;
    protocol_address?: string;
    expiration_date?: string;
    is_private?: boolean;
    event_timestamp?: string;
    transaction?: { hash: string; timestamp: string };
    from_account?: { address: string };
    to_account?: { address: string };
  };
  sent_at: string;
}

// WebSocket connection
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 15;
const BASE_RECONNECT_DELAY = 1000; // Start with 1 second
const MAX_RECONNECT_DELAY = 60000; // Max 60 seconds

// Heartbeat/ping interval to keep connection alive
let heartbeatInterval: NodeJS.Timeout | null = null;
const HEARTBEAT_INTERVAL = 30000; // Send ping every 30 seconds

const eventEmitter = new EventEmitter();
const subscribedCollections = new Set<string>();

// Keep track of connected Socket.io clients
let socketIoServer: Server | null = null;

export function setSocketIoServer(io: Server) {
  socketIoServer = io;
}

// Calculate exponential backoff delay
function getReconnectDelay(): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped)
  const delay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  // Add jitter (±20%) to prevent thundering herd
  const jitter = delay * 0.2 * (Math.random() - 0.5);
  return Math.floor(delay + jitter);
}

// Start heartbeat ping to keep connection alive
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === 1) { // OPEN
      messageRef++;
      const pingMessage = {
        topic: 'phoenix',
        event: 'heartbeat',
        payload: {},
        ref: messageRef.toString(),
      };
      try {
        ws.send(JSON.stringify(pingMessage));
        console.log('💓 OpenSea Stream heartbeat sent');
      } catch (e) {
        console.error('Failed to send heartbeat:', e);
      }
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function connect() {
  if (!OPENSEA_API_KEY) {
    console.log('⚠️ OpenSea API key not configured, WebSocket disabled');
    streamAvailable = false;
    return;
  }

  // Clean up any existing connection SAFELY
  if (ws) {
    try {
      ws.removeAllListeners();
      // Only close if connection is open or connecting
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch (e) {
      // Ignore cleanup errors - connection might already be closed
      console.log('⚠️ WebSocket cleanup error (safe to ignore):', (e as Error).message);
    }
    ws = null;
  }
  stopHeartbeat();

  try {
    console.log('🔄 Connecting to OpenSea Stream API...');
    ws = new WebSocket(`${OPENSEA_STREAM_URL}?token=${OPENSEA_API_KEY}`);

    // CRITICAL: Handle error event BEFORE it can crash the process
    // This MUST be registered before any async operations
    ws.on('error', (error: any) => {
      const errorCode = error?.code || error?.message || 'unknown';
      const errorMsg = error?.message || String(error);
      console.error(`⚠️ OpenSea WebSocket error (${errorCode}):`, errorMsg);
      
      // Track the error for status reporting
      lastStreamError = errorMsg;
      streamAvailable = false;
      
      // DO NOT rethrow - this prevents process crash
      // The 'close' event will trigger reconnect if needed
    });

    ws.on('open', () => {
      console.log('🔌 Connected to OpenSea Stream API');
      reconnectAttempts = 0;
      streamAvailable = true;
      lastStreamError = null;
      
      // Start heartbeat to keep connection alive
      startHeartbeat();
      
      // Re-subscribe to all collections
      const collectionsToRestore = Array.from(subscribedCollections);
      if (collectionsToRestore.length > 0) {
        console.log(`🔄 Restoring ${collectionsToRestore.length} subscription(s)...`);
        for (const collection of collectionsToRestore) {
          subscribeToCollection(collection);
        }
        console.log(`✅ Restored subscriptions: ${collectionsToRestore.join(', ')}`);
      }
    });

    ws.on('message', (rawData: Buffer | string) => {
      try {
        const data = JSON.parse(rawData.toString());
        
        // Handle Phoenix channel responses
        if (data.event === 'phx_reply') {
          if (data.payload?.status === 'ok') {
            console.log(`✅ Subscription confirmed for topic: ${data.topic}`);
          } else if (data.payload?.status === 'error') {
            console.error(`❌ Subscription failed for topic: ${data.topic}`, data.payload?.response);
          }
          return;
        }

        // Handle heartbeat response
        if (data.event === 'heartbeat' || data.event === 'phx_reply' && data.topic === 'phoenix') {
          // Heartbeat acknowledged
          return;
        }

        // Handle actual events
        if (data.event && data.payload) {
          handleStreamEvent({
            event_type: data.event as OpenSeaEventType,
            payload: data.payload,
            sent_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.error('Error parsing OpenSea event:', e);
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason?.toString() || 'no reason';
      console.log(`🔌 OpenSea WebSocket disconnected (code: ${code}, reason: ${reasonStr})`);
      streamAvailable = false;
      stopHeartbeat();
      attemptReconnect();
    });

    // Handle unexpected HTTP responses (502, 504, etc.)
    ws.on('unexpected-response', (req: any, res: any) => {
      const statusCode = res?.statusCode || 'unknown';
      console.error(`⚠️ OpenSea WebSocket unexpected response: ${statusCode}`);
      lastStreamError = `HTTP ${statusCode}`;
      streamAvailable = false;
      stopHeartbeat();
      // Don't call attemptReconnect here - 'close' event will fire after this
    });
  } catch (e: any) {
    console.error('⚠️ Failed to create OpenSea WebSocket:', e.message || e);
    lastStreamError = e.message || 'Connection failed';
    streamAvailable = false;
    attemptReconnect();
  }
}

function attemptReconnect() {
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    const delay = getReconnectDelay();
    console.log(`🔄 Reconnecting to OpenSea Stream in ${(delay/1000).toFixed(1)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(connect, delay);
  } else {
    console.error('❌ Max reconnect attempts reached for OpenSea Stream. Will retry in 5 minutes.');
    // Reset and try again after a longer delay
    setTimeout(() => {
      console.log('🔄 Resetting reconnect attempts and trying again...');
      reconnectAttempts = 0;
      connect();
    }, 5 * 60 * 1000); // 5 minutes
  }
}

function sendHeartbeat(ref: string) {
  if (ws && ws.readyState === 1) { // OPEN
    ws.send(JSON.stringify({
      topic: 'phoenix',
      event: 'heartbeat',
      payload: {},
      ref,
    }));
  }
}

let messageRef = 0;

export function subscribeToCollection(collectionSlug: string) {
  subscribedCollections.add(collectionSlug);
  
  if (ws && ws.readyState === 1) { // 1 = OPEN
    messageRef++;
    const message = {
      topic: `collection:${collectionSlug}`,
      event: 'phx_join',
      payload: {},
      ref: messageRef.toString(),
    };
    
    ws.send(JSON.stringify(message));
    console.log(`📡 Subscribed to collection: ${collectionSlug}`);
  }
}

export function unsubscribeFromCollection(collectionSlug: string) {
  subscribedCollections.delete(collectionSlug);
  
  if (ws && ws.readyState === 1) { // 1 = OPEN
    messageRef++;
    const message = {
      topic: `collection:${collectionSlug}`,
      event: 'phx_leave',
      payload: {},
      ref: messageRef.toString(),
    };
    
    ws.send(JSON.stringify(message));
    console.log(`📴 Unsubscribed from collection: ${collectionSlug}`);
  }
}

function handleStreamEvent(event: StreamEvent) {
  // Transform to our event format
  const transformedEvent = transformOpenSeaEvent(event);
  
  // Emit to internal listeners
  eventEmitter.emit('event', transformedEvent);
  eventEmitter.emit(event.event_type, transformedEvent);
  
  // Broadcast to Socket.io clients
  if (socketIoServer) {
    const room = event.payload?.collection?.slug;
    if (room) {
      socketIoServer.to(room).emit('marketplace:event', transformedEvent);
    }
    // Also broadcast to 'all' room
    socketIoServer.to('all').emit('marketplace:event', transformedEvent);
  }

  console.log(`📨 OpenSea event: ${event.event_type} for ${event.payload?.item?.nft_id || 'unknown'}`);
}

function transformOpenSeaEvent(event: StreamEvent): any {
  const payload = event.payload;
  const item = payload.item;
  
  // Parse NFT ID (format: chain/contract/tokenId)
  const nftIdParts = item?.nft_id?.split('/') || [];
  const chain = nftIdParts[0] || item?.chain?.name || 'ethereum';
  const contractAddress = nftIdParts[1] || '';
  const tokenId = nftIdParts[2] || '';

  // Map event type
  const eventTypeMap: Record<string, string> = {
    'item_listed': 'listing',
    'item_sold': 'sale',
    'item_transferred': 'transfer',
    'item_cancelled': 'cancel',
    'item_received_offer': 'offer',
    'item_received_bid': 'offer',
    'collection_offer': 'offer',
  };

  return {
    id: `os-${event.event_type}-${payload.order_hash || payload.transaction?.hash || Date.now()}`,
    event_type: eventTypeMap[event.event_type] || event.event_type,
    collection_address: contractAddress.toLowerCase(),
    collection_slug: payload.collection?.slug || null,
    token_id: tokenId,
    from_address: payload.maker?.address || payload.from_account?.address || null,
    to_address: payload.taker?.address || payload.to_account?.address || null,
    price_wei: payload.base_price || null,
    currency: payload.payment_token?.symbol || 'ETH',
    tx_hash: payload.transaction?.hash || null,
    order_hash: payload.order_hash || null,
    timestamp: payload.event_timestamp || payload.transaction?.timestamp || event.sent_at,
    image: item?.metadata?.image_url || null,
    name: item?.metadata?.name || `#${tokenId}`,
    permalink: item?.permalink || null,
    chain,
    source: 'opensea-stream',
  };
}

// Event listener helpers
export function onEvent(callback: (event: any) => void) {
  eventEmitter.on('event', callback);
}

export function onEventType(type: OpenSeaEventType, callback: (event: any) => void) {
  eventEmitter.on(type, callback);
}

// Initialize connection
export function initOpenSeaStream() {
  if (!OPENSEA_API_KEY) {
    console.log('⚠️ OpenSea Stream API disabled (no API key)');
    return;
  }
  
  console.log('🚀 Initializing OpenSea Stream API...');
  connect();
}

// Get connection status
export function getStreamStatus() {
  return {
    connected: ws?.readyState === 1, // 1 = OPEN
    available: streamAvailable,
    subscribedCollections: Array.from(subscribedCollections),
    reconnectAttempts,
    apiKeyConfigured: !!OPENSEA_API_KEY,
    lastError: lastStreamError,
    readyState: ws?.readyState ?? null,
  };
}

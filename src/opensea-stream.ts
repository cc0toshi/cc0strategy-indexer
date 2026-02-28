// OpenSea Stream API WebSocket Integration
// Docs: https://docs.opensea.io/reference/stream-api-overview

import type { Server } from 'socket.io';
import { EventEmitter } from 'events';

const OPENSEA_STREAM_URL = 'wss://stream.openseabeta.com/socket/websocket';
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY || '';

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

// Simple WebSocket implementation using native WebSocket
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000;

const eventEmitter = new EventEmitter();
const subscribedCollections = new Set<string>();

// Keep track of connected Socket.io clients
let socketIoServer: Server | null = null;

export function setSocketIoServer(io: Server) {
  socketIoServer = io;
}

function connect() {
  if (!OPENSEA_API_KEY) {
    console.log('⚠️ OpenSea API key not configured, WebSocket disabled');
    return;
  }

  try {
    ws = new WebSocket(`${OPENSEA_STREAM_URL}?token=${OPENSEA_API_KEY}`);

    ws.onopen = () => {
      console.log('🔌 Connected to OpenSea Stream API');
      reconnectAttempts = 0;
      
      // Re-subscribe to all collections
      for (const collection of subscribedCollections) {
        subscribeToCollection(collection);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data.toString());
        
        // Handle Phoenix channel responses
        if (data.event === 'phx_reply') {
          if (data.payload?.status === 'ok') {
            console.log(`✅ Subscription confirmed for topic: ${data.topic}`);
          }
          return;
        }

        // Handle heartbeat
        if (data.event === 'heartbeat') {
          sendHeartbeat(data.ref);
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
    };

    ws.onerror = (error) => {
      console.error('OpenSea WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('🔌 OpenSea WebSocket disconnected');
      attemptReconnect();
    };
  } catch (e) {
    console.error('Failed to connect to OpenSea Stream:', e);
    attemptReconnect();
  }
}

function attemptReconnect() {
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    console.log(`Reconnecting to OpenSea Stream (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(connect, RECONNECT_DELAY * reconnectAttempts);
  } else {
    console.error('Max reconnect attempts reached for OpenSea Stream');
  }
}

function sendHeartbeat(ref: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
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
  
  if (ws && ws.readyState === WebSocket.OPEN) {
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
  
  if (ws && ws.readyState === WebSocket.OPEN) {
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
    connected: ws?.readyState === WebSocket.OPEN,
    subscribedCollections: Array.from(subscribedCollections),
    reconnectAttempts,
  };
}

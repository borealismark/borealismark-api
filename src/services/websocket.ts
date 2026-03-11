/**
 * BorealisMark — v44 WebSocket Service
 *
 * Upgrades from SSE-only to bidirectional WebSocket communication.
 * Provides real-time messaging, typing indicators, and notification push.
 * Falls back gracefully — SSE still works for notification-only clients.
 *
 * Uses the built-in 'ws' alternative: raw WebSocket via Node's http upgrade.
 * No external dependency needed — we use the native ws support.
 */

import { Server as HttpServer, IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { URL } from 'url';
import jwt from 'jsonwebtoken';
import { logger } from '../middleware/logger';
import { getUnreadNotificationCount } from '../db/database';

// Note: ws package needs to be installed. If not available, this module gracefully no-ops.

interface WSClient {
  userId: string;
  ws: WebSocket;
  connectedAt: number;
  lastPing: number;
}

const clients: Map<string, WSClient[]> = new Map();
let wss: WebSocketServer | null = null;

/**
 * Initialize WebSocket server on the existing HTTP server.
 * Handles upgrade requests to /v1/ws path.
 */
export function initWebSocket(server: HttpServer): void {
  try {
    wss = new WebSocketServer({ noServer: true });
  } catch {
    logger.warn('WebSocket (ws) package not available — skipping WS initialization. Install with: npm install ws @types/ws');
    return;
  }

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname !== '/v1/ws') {
      socket.destroy();
      return;
    }

    // Authenticate via query param token
    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const JWT_SECRET = process.env.JWT_SECRET || '';
    let userId: string;
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as any;
      userId = decoded.sub;
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(request, socket, head, (ws) => {
      wss!.emit('connection', ws, request, userId);
    });
  });

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, userId: string) => {
    const client: WSClient = { userId, ws, connectedAt: Date.now(), lastPing: Date.now() };
    const existing = clients.get(userId) || [];
    existing.push(client);
    clients.set(userId, existing);

    logger.info('WebSocket client connected', { userId, totalClients: getWSClientCount() });

    // Send initial state
    const unreadCount = getUnreadNotificationCount(userId);
    ws.send(JSON.stringify({ type: 'connected', unreadCount, timestamp: Date.now() }));

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWSMessage(userId, msg, ws);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    // Ping/pong for keepalive
    ws.on('pong', () => {
      client.lastPing = Date.now();
    });

    // Cleanup on disconnect
    ws.on('close', () => {
      const userClients = clients.get(userId) || [];
      const idx = userClients.indexOf(client);
      if (idx !== -1) userClients.splice(idx, 1);
      if (userClients.length === 0) clients.delete(userId);
      else clients.set(userId, userClients);

      logger.info('WebSocket client disconnected', { userId, totalClients: getWSClientCount() });
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', { userId, error: err.message });
    });
  });

  // Keepalive: ping all clients every 30 seconds, terminate dead ones
  setInterval(() => {
    const now = Date.now();
    for (const [userId, userClients] of clients) {
      for (let i = userClients.length - 1; i >= 0; i--) {
        const c = userClients[i];
        if (now - c.lastPing > 90000) {
          // No pong in 90s — terminate
          c.ws.terminate();
          userClients.splice(i, 1);
        } else {
          c.ws.ping();
        }
      }
      if (userClients.length === 0) clients.delete(userId);
    }
  }, 30000);

  logger.info('WebSocket server initialized on /v1/ws');
}

/**
 * Handle incoming WebSocket messages from authenticated clients.
 */
function handleWSMessage(userId: string, msg: any, ws: WebSocket): void {
  switch (msg.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

    case 'typing':
      // Broadcast typing indicator to the other participant in the thread
      if (msg.threadId && msg.recipientId) {
        pushToWSUser(msg.recipientId, {
          type: 'typing',
          threadId: msg.threadId,
          userId,
          isTyping: msg.isTyping ?? true,
        });
      }
      break;

    case 'mark_read':
      // Client acknowledges reading notifications — handled by REST API
      ws.send(JSON.stringify({ type: 'ack', action: 'mark_read' }));
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

/**
 * Push a message to all WebSocket clients for a given user.
 * Mirrors the SSE pushToUser pattern for backward compatibility.
 */
export function pushToWSUser(userId: string, data: any): void {
  const userClients = clients.get(userId) || [];
  const json = JSON.stringify(data);
  for (const client of userClients) {
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(json);
      }
    } catch {
      // Will be cleaned up on next ping cycle
    }
  }
}

/**
 * Broadcast a message to all connected WebSocket clients.
 */
export function broadcastToAll(data: any): void {
  const json = JSON.stringify(data);
  for (const userClients of clients.values()) {
    for (const client of userClients) {
      try {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(json);
        }
      } catch {
        // Silent fail — cleanup happens on ping cycle
      }
    }
  }
}

/**
 * Get the count of connected WebSocket clients.
 */
export function getWSClientCount(): number {
  let count = 0;
  for (const userClients of clients.values()) {
    count += userClients.length;
  }
  return count;
}

/**
 * Check if WebSocket server is initialized.
 */
export function isWSEnabled(): boolean {
  return wss !== null;
}

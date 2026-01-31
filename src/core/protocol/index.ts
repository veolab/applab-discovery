/**
 * DiscoveryLab WebSocket Protocol
 *
 * Typed WebSocket protocol inspired by Clawdbot's gateway pattern.
 *
 * Usage:
 *   import { createRequest, createResponse, createEvent, validateRequest } from './protocol';
 *
 *   // Create typed messages
 *   const req = createRequest('recorder.start', { name: 'test', url: 'https://example.com' });
 *   const res = createResponse(req.id, true, { id: '123', ... });
 *   const evt = createEvent('action', { id: '1', type: 'click', ... });
 *
 *   // Validate incoming messages
 *   const result = validateRequest(incomingMsg);
 *   if (!result.valid) console.error(formatValidationErrors(result.errors));
 */

export * from './types.js';
export * from './validator.js';

import { randomUUID } from 'node:crypto';
import type {
  WSRequest,
  WSResponse,
  WSEvent,
  WSMethodMap,
  WSEventMap,
} from './types.js';

// ============================================================================
// MESSAGE FACTORIES
// ============================================================================

/**
 * Create a typed request message
 */
export function createRequest<M extends keyof WSMethodMap>(
  method: M,
  params: WSMethodMap[M]['params']
): WSRequest<WSMethodMap[M]['params']> {
  return {
    type: 'req',
    id: randomUUID(),
    method,
    params,
  };
}

/**
 * Create a typed response message
 */
export function createResponse<T>(
  id: string,
  ok: true,
  payload: T
): WSResponse<T>;
export function createResponse(
  id: string,
  ok: false,
  error: string
): WSResponse<never>;
export function createResponse<T>(
  id: string,
  ok: boolean,
  payloadOrError: T | string
): WSResponse<T> {
  if (ok) {
    return {
      type: 'res',
      id,
      ok: true,
      payload: payloadOrError as T,
    };
  } else {
    return {
      type: 'res',
      id,
      ok: false,
      error: payloadOrError as string,
    };
  }
}

/**
 * Create a typed event message
 */
export function createEvent<E extends keyof WSEventMap>(
  event: E,
  payload: WSEventMap[E],
  seq?: number
): WSEvent<WSEventMap[E]> {
  return {
    type: 'event',
    event,
    payload,
    seq,
    timestamp: Date.now(),
  };
}

// ============================================================================
// SEQUENCE NUMBER GENERATOR
// ============================================================================

let eventSequence = 0;

/**
 * Get next event sequence number
 */
export function nextEventSeq(): number {
  return ++eventSequence;
}

/**
 * Reset event sequence (for testing)
 */
export function resetEventSeq(): void {
  eventSequence = 0;
}

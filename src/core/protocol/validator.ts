/**
 * DiscoveryLab WebSocket Protocol Validator
 *
 * JSON Schema-based validation for WebSocket messages.
 * Inspired by Clawdbot's AJV validators pattern.
 */

import type {
  WSRequest,
  WSResponse,
  WSEvent,
  WSMessage,
  WSMethod,
  WSEventType,
} from './types.js';

// ============================================================================
// JSON SCHEMAS
// ============================================================================

export const schemas = {
  request: {
    type: 'object',
    required: ['type', 'id', 'method'],
    properties: {
      type: { const: 'req' },
      id: { type: 'string' },
      method: { type: 'string' },
      params: { type: 'object' },
    },
    additionalProperties: false,
  },

  response: {
    type: 'object',
    required: ['type', 'id', 'ok'],
    properties: {
      type: { const: 'res' },
      id: { type: 'string' },
      ok: { type: 'boolean' },
      payload: {},
      error: { type: 'string' },
    },
    additionalProperties: false,
  },

  event: {
    type: 'object',
    required: ['type', 'event', 'payload'],
    properties: {
      type: { const: 'event' },
      event: { type: 'string' },
      payload: {},
      seq: { type: 'number' },
      timestamp: { type: 'number' },
    },
    additionalProperties: false,
  },

  // Method-specific param schemas
  methods: {
    'ping': {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    'recorder.start': {
      type: 'object',
      required: ['name', 'url'],
      properties: {
        name: { type: 'string' },
        url: { type: 'string' },
        resolution: {
          type: 'object',
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
      },
      additionalProperties: false,
    },
    'recorder.stop': {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    'recorder.status': {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    'liveStream.start': {
      type: 'object',
      required: ['platform'],
      properties: {
        platform: { enum: ['ios', 'android'] },
        deviceId: { type: 'string' },
        interactive: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    'liveStream.stop': {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    'liveStream.tap': {
      type: 'object',
      required: ['x', 'y'],
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
      },
      additionalProperties: false,
    },
    'project.list': {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    'project.get': {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
      },
      additionalProperties: false,
    },
    'project.create': {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        packageName: { type: 'string' },
      },
      additionalProperties: false,
    },
    'project.delete': {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
      },
      additionalProperties: false,
    },
  } as Record<string, object>,
} as const;

// ============================================================================
// VALIDATION ERRORS
// ============================================================================

export interface ValidationError {
  path: string;
  message: string;
  expected?: string;
  received?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ============================================================================
// VALIDATOR FUNCTIONS
// ============================================================================

/**
 * Simple JSON Schema validator
 * (Can be replaced with AJV for more complex validation)
 */
function validateSchema(data: unknown, schema: any, path = ''): ValidationError[] {
  const errors: ValidationError[] = [];

  if (schema.const !== undefined) {
    if (data !== schema.const) {
      errors.push({
        path: path || 'root',
        message: `Expected constant value`,
        expected: String(schema.const),
        received: String(data),
      });
    }
    return errors;
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.includes(data)) {
      errors.push({
        path: path || 'root',
        message: `Value must be one of: ${schema.enum.join(', ')}`,
        received: String(data),
      });
    }
    return errors;
  }

  if (schema.type === 'object') {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      errors.push({
        path: path || 'root',
        message: 'Expected object',
        expected: 'object',
        received: typeof data,
      });
      return errors;
    }

    const obj = data as Record<string, unknown>;

    // Check required properties
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push({
            path: `${path}.${key}`,
            message: `Missing required property: ${key}`,
          });
        }
      }
    }

    // Validate properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const propErrors = validateSchema(obj[key], propSchema, `${path}.${key}`);
          errors.push(...propErrors);
        }
      }
    }

    // Check additional properties
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) {
          errors.push({
            path: `${path}.${key}`,
            message: `Unexpected property: ${key}`,
          });
        }
      }
    }
  } else if (schema.type === 'string') {
    if (typeof data !== 'string') {
      errors.push({
        path: path || 'root',
        message: 'Expected string',
        expected: 'string',
        received: typeof data,
      });
    }
  } else if (schema.type === 'number') {
    if (typeof data !== 'number') {
      errors.push({
        path: path || 'root',
        message: 'Expected number',
        expected: 'number',
        received: typeof data,
      });
    }
  } else if (schema.type === 'boolean') {
    if (typeof data !== 'boolean') {
      errors.push({
        path: path || 'root',
        message: 'Expected boolean',
        expected: 'boolean',
        received: typeof data,
      });
    }
  }

  return errors;
}

/**
 * Validate a WebSocket request message
 */
export function validateRequest(msg: unknown): ValidationResult {
  const errors = validateSchema(msg, schemas.request);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate request params for a specific method
 */
export function validateMethodParams(method: string, params: unknown): ValidationResult {
  const schema = schemas.methods[method];
  if (!schema) {
    return {
      valid: false,
      errors: [{ path: 'method', message: `Unknown method: ${method}` }],
    };
  }

  const errors = validateSchema(params ?? {}, schema);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a WebSocket response message
 */
export function validateResponse(msg: unknown): ValidationResult {
  const errors = validateSchema(msg, schemas.response);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a WebSocket event message
 */
export function validateEvent(msg: unknown): ValidationResult {
  const errors = validateSchema(msg, schemas.event);
  return { valid: errors.length === 0, errors };
}

/**
 * Format validation errors for display
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors
    .map((e) => {
      let msg = `${e.path}: ${e.message}`;
      if (e.expected) msg += ` (expected: ${e.expected})`;
      if (e.received) msg += ` (received: ${e.received})`;
      return msg;
    })
    .join('\n');
}

// ============================================================================
// AVAILABLE METHODS
// ============================================================================

export const availableMethods: WSMethod[] = [
  'ping',
  'recorder.start',
  'recorder.stop',
  'recorder.status',
  'liveStream.start',
  'liveStream.stop',
  'liveStream.tap',
  'project.list',
  'project.get',
  'project.create',
  'project.delete',
];

export const availableEvents: WSEventType[] = [
  'action',
  'screenshot',
  'status',
  'stopped',
  'session',
  'liveFrame',
  'error',
  'connected',
];

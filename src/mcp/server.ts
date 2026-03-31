/**
 * DiscoveryLab MCP Server
 * Model Context Protocol server for Claude Code integration
 */

import { z } from 'zod';
import { APP_VERSION } from '../core/appVersion.js';

// ============================================================================
// TYPES
// ============================================================================
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  _meta?: Record<string, any>;
  handler: (params: any) => Promise<MCPToolResult>;
}

export interface MCPToolContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface MCPToolResult {
  content: MCPToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, any>;
  _meta?: Record<string, any>;
}

export interface MCPResourceContents {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, any>;
}

export interface MCPResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  contents?: MCPResourceContents[];
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

// ============================================================================
// MCP SERVER
// ============================================================================
export class MCPServer {
  private tools: Map<string, MCPTool> = new Map();
  private resources: Map<string, MCPResource> = new Map();
  private serverInfo = {
    name: 'discoverylab',
    version: APP_VERSION,
  };

  registerTool(tool: MCPTool): void {
    this.tools.set(tool.name, tool);
  }

  registerTools(tools: MCPTool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
  }

  registerResource(resource: MCPResource): void {
    this.resources.set(resource.uri, resource);
  }

  upsertResourceContents(uri: string, resource: Omit<MCPResource, 'uri'>): void {
    this.resources.set(uri, {
      uri,
      ...resource,
    });
  }

  async handleRequest(request: MCPRequest): Promise<MCPResponse> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize':
          return this.handleInitialize(id, params);

        case 'tools/list':
          return this.handleToolsList(id);

        case 'tools/call':
          return this.handleToolCall(id, params);

        case 'resources/list':
          return this.handleResourcesList(id);

        case 'resources/read':
          return this.handleResourcesRead(id, params);

        case 'ping':
          return { jsonrpc: '2.0', id, result: { pong: true } };

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message },
      };
    }
  }

  private handleInitialize(id: string | number, params: any): MCPResponse {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: this.serverInfo,
        capabilities: {
          tools: {},
          resources: {},
        },
      },
    };
  }

  private handleToolsList(id: string | number): MCPResponse {
    const tools = Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: this.zodToJsonSchema(tool.inputSchema),
      ...(tool._meta ? { _meta: tool._meta } : {}),
    }));

    return {
      jsonrpc: '2.0',
      id,
      result: { tools },
    };
  }

  private handleResourcesList(id: string | number): MCPResponse {
    const resources = Array.from(this.resources.values()).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      ...(resource.title ? { title: resource.title } : {}),
      ...(resource.description ? { description: resource.description } : {}),
      mimeType: resource.mimeType,
    }));

    return {
      jsonrpc: '2.0',
      id,
      result: { resources },
    };
  }

  private handleResourcesRead(id: string | number, params: any): MCPResponse {
    const uri = typeof params?.uri === 'string' ? params.uri : '';
    const resource = this.resources.get(uri);

    if (!resource) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Resource not found: ${uri}` },
      };
    }

    const contents = Array.isArray(resource.contents) && resource.contents.length > 0
      ? resource.contents
      : [{
          uri: resource.uri,
          mimeType: resource.mimeType,
        }];

    return {
      jsonrpc: '2.0',
      id,
      result: { contents },
    };
  }

  private async handleToolCall(id: string | number, params: any): Promise<MCPResponse> {
    const { name, arguments: args } = params;

    const tool = this.tools.get(name);
    if (!tool) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Tool not found: ${name}` },
      };
    }

    try {
      // Validate input
      const validatedArgs = tool.inputSchema.parse(args || {});

      // Execute handler
      const result = await tool.handler(validatedArgs);

      return {
        jsonrpc: '2.0',
        id,
        result,
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: 'Invalid parameters',
            data: error.errors,
          },
        };
      }

      const message = error instanceof Error ? error.message : 'Tool execution failed';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        },
      };
    }
  }

  private zodToJsonSchema(schema: z.ZodType<any>): any {
    // Simple conversion for common types
    if (schema instanceof z.ZodObject) {
      const shape = schema.shape;
      const properties: any = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = this.zodToJsonSchema(value as z.ZodType<any>);
        if (!(value as any).isOptional()) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }

    if (schema instanceof z.ZodString) {
      return { type: 'string' };
    }

    if (schema instanceof z.ZodNumber) {
      return { type: 'number' };
    }

    if (schema instanceof z.ZodBoolean) {
      return { type: 'boolean' };
    }

    if (schema instanceof z.ZodArray) {
      return {
        type: 'array',
        items: this.zodToJsonSchema(schema.element),
      };
    }

    if (schema instanceof z.ZodOptional) {
      return this.zodToJsonSchema(schema.unwrap());
    }

    if (schema instanceof z.ZodEnum) {
      return {
        type: 'string',
        enum: schema.options,
      };
    }

    // Default fallback
    return { type: 'object' };
  }

  // STDIO transport
  async runStdio(): Promise<void> {
    const readline = await import('node:readline');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on('line', async (line) => {
      try {
        const request = JSON.parse(line) as MCPRequest;
        const response = await this.handleRequest(request);
        console.log(JSON.stringify(response));
      } catch (error) {
        const errorResponse: MCPResponse = {
          jsonrpc: '2.0',
          id: 0,
          error: { code: -32700, message: 'Parse error' },
        };
        console.log(JSON.stringify(errorResponse));
      }
    });

    rl.on('close', () => {
      process.exit(0);
    });
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
export function createTextResult(text: string): MCPToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

export function createErrorResult(message: string): MCPToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export function createJsonResult(data: any): MCPToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================
export const mcpServer = new MCPServer();

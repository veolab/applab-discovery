/**
 * DiscoveryLab MCP Server
 * Model Context Protocol server for Claude Code integration
 */

import { z } from 'zod';

// ============================================================================
// TYPES
// ============================================================================
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: z.ZodType<any>;
  handler: (params: any) => Promise<MCPToolResult>;
}

export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
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
  private serverInfo = {
    name: 'discoverylab',
    version: '0.1.0',
  };

  registerTool(tool: MCPTool): void {
    this.tools.set(tool.name, tool);
  }

  registerTools(tools: MCPTool[]): void {
    for (const tool of tools) {
      this.registerTool(tool);
    }
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
        },
      },
    };
  }

  private handleToolsList(id: string | number): MCPResponse {
    const tools = Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: this.zodToJsonSchema(tool.inputSchema),
    }));

    return {
      jsonrpc: '2.0',
      id,
      result: { tools },
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

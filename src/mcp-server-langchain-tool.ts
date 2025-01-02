// Copyright (C) 2024 Hideya Kawahara
// SPDX-License-Identifier: MIT

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { jsonSchemaToZod, JsonSchema } from '@n8n/json-schema-to-zod';
import { z } from 'zod';
import { Logger } from './logger';

interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface MCPServersConfig {
  [key: string]: MCPServerConfig;
}

interface LogOptions {
  logLevel?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
}

export async function convertMCPServersToLangChainTools(
  configs: MCPServersConfig,
  options?: LogOptions
): Promise<{
  allTools: DynamicStructuredTool[];
  cleanup: () => Promise<void>;
}> {
  const allTools: DynamicStructuredTool[] = [];
  const cleanupCallbacks: (() => Promise<void>)[] = [];
  const logger = new Logger({level: options?.logLevel || 'info'});

  const serverInitPromises = Object.entries(configs).map(async ([name, config]) => {
    logger.info(`Initializing MCP server "${name}"`);
    logger.debug(`with config: `, config);
    const result = await convertMCPServerToLangChainTools(name, config, logger);
    return {name, result};
  });

  // Track server names alongside their promises
  const serverNames = Object.keys(configs);

  // Concurrently initialize all the MCP servers
  const results = await Promise.allSettled(
    serverInitPromises
  );
  
  // Process successful initializations and log failures
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      const { result: { tools, cleanup } } = result.value;
      allTools.push(...tools);
      cleanupCallbacks.push(cleanup);
    } else {
      console.error(`\x1b[31mERROR\x1b[0m: MCP server "${serverNames[index]}": failed to initialize: ${result.reason}`);
    }
  });

  async function cleanup(): Promise<void> {
    // Concurrently execute all the callbacks
    const results = await Promise.allSettled(cleanupCallbacks.map(callback => callback()));
    
    // Log any cleanup failures
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) {
      failures.forEach((failure, index) => {
        console.error(`\x1b[31mERROR\x1b[0m: MCP server "${serverNames[index]}": failed to close: ${failure.reason}`);
      });
    }
  }

  logger.info(`MCP servers initialized and found ${allTools.length} tool(s) in total:`);
  allTools.forEach((tool) => logger.info(`- ${tool.name}`));

  return { allTools, cleanup };
}

async function convertMCPServerToLangChainTools(
  serverName: string,
  config: MCPServerConfig,
  logger: Logger
): Promise<{
  tools: DynamicStructuredTool[];
  cleanup: () => Promise<void>;
}> {

  const transport = new StdioClientTransport(
    {
      command: config.command,
      args: config.args,
      env: config.env,
    },
  );

  const client = new Client(
    {
      name: "mcp-client",
      version: "0.0.1",
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);

  const toolsResponse = await client.request(
    { method: "tools/list" },
    ListToolsResultSchema
  );

  logger.info(`MCP server "${serverName}": connected`);

  const tools = toolsResponse.tools.map((tool) => (
    new DynamicStructuredTool({
      name: tool.name,
      description: tool.description || '',
      schema: jsonSchemaToZod(tool.inputSchema as JsonSchema) as z.ZodObject<any>,

      func: async (input) => {
        logger.info(`MCP Tool "${tool.name}" received input:`, input);

        if (Object.keys(input).length === 0) {
          return 'No input provided';
        }

        // Execute tool call
        const result = await client.request(
          {
            method: "tools/call",
            params: {
              name: tool.name,
              arguments: input,
            },
          },
          CallToolResultSchema
        );

        logger.info(`MCP Tool "${tool.name}" received result`);
        logger.debug('result:', result);

        const filteredResult = result.content.filter(content => content.type === 'text').map((content) => {
          return content.text
        }).join('\n\n');

        // return JSON.stringify(result.content);
        return filteredResult;
      },
    })
  ));

  logger.info(`MCP server "${serverName}": found ${tools.length} tool(s)`);
  tools.forEach((tool) => logger.debug(`- ${tool.name}`));

  async function cleanup(): Promise<void> {
    if (transport) {
      await transport.close();
      logger.info(`Closed MCP connection to "${serverName}"`);
    }
  }

  return { tools, cleanup };
}

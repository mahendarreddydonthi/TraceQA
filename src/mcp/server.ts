import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ExploreSession } from '../core/explorer.js';
import { AGENT_GUIDE } from '../core/init.js';
import { buildTools } from '../tools/registry.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export async function startMcpServer(projectDir?: string): Promise<void> {
  // stdout carries the MCP protocol; send any stray logging to stderr.
  console.log = (...args: unknown[]) => console.error(...args);

  const server = new McpServer(
    { name: 'traceqa', version: '0.5.0' },
    { instructions: `TraceQA tests a web app against its written requirements and keeps a Playwright framework in sync.\n\n${AGENT_GUIDE}` },
  );

  for (const tool of buildTools(projectDir)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: !!tool.readOnly, destructiveHint: !!tool.destructive, openWorldHint: false },
      },
      async (args: unknown): Promise<ToolResult> => {
        try {
          return { content: [{ type: 'text', text: await tool.run(args) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    );
  }

  server.registerPrompt(
    'test_requirement',
    { title: 'Test a requirement', description: 'Explore one requirement, write a test per acceptance criterion, run them and report.', argsSchema: { requirementId: z.string() } },
    ({ requirementId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Use TraceQA to test ${requirementId}. Call status and get_requirement first. Explore it in the browser, record real problems as findings, then save one test per acceptance criterion with save_test, run_tests for ${requirementId}, and summarise the results and any draft bugs. Do not approve or file bugs.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'triage_failures',
    { title: 'Triage the latest failures', description: 'Explain each failing test, heal broken ones, and summarise real bugs.', argsSchema: {} },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Use TraceQA: run_tests, then heal_tests for test-broken failures. For anything heal_tests cannot fix, check locators with get_page or an exploration snapshot and fix it with save_test. Leave app-bug failures failing and summarise their draft bugs.',
          },
        },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`TraceQA MCP server ready (project: ${projectDir ? path.resolve(projectDir) : process.cwd()})`);

  const shutdown = async () => {
    if (ExploreSession.active) await ExploreSession.active.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

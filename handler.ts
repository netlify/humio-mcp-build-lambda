/**
 * Lambda Function URL handler for humio-mcp MCP server.
 *
 * Proxies HTTP requests from Lambda Function URL to humio-mcp subprocess
 * via stdio (stdin/stdout MCP transport).
 */

import { spawn, ChildProcess } from 'child_process';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

// Set up environment from Lambda environment variables
const HUMIO_API_TOKEN = process.env.HUMIO_API_TOKEN;
const HUMIO_REQUEST_TIMEOUT_MS = parseInt(process.env.HUMIO_REQUEST_TIMEOUT_MS || '30000', 10);

if (!HUMIO_API_TOKEN) {
  console.error('HUMIO_API_TOKEN environment variable not set');
  process.exit(1);
}

/**
 * Lambda handler for Function URL requests
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    // Extract request body
    const body = event.body || '';
    if (!body) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Empty request body' }),
      };
    }

    // Spawn humio-mcp process with environment variables
    const mcpProcess = spawn('humio-mcp', [], {
      env: {
        ...process.env,
        HUMIO_API_TOKEN,
        HUMIO_REQUEST_TIMEOUT_MS: String(HUMIO_REQUEST_TIMEOUT_MS),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: HUMIO_REQUEST_TIMEOUT_MS + 5000, // Add 5s buffer for cleanup
    });

    // Set up timeout
    const timeout = setTimeout(() => {
      mcpProcess.kill();
    }, HUMIO_REQUEST_TIMEOUT_MS);

    // Collect output
    let output = '';
    let errorOutput = '';

    return new Promise((resolve) => {
      mcpProcess.stdout?.on('data', (data) => {
        output += data.toString();
      });

      mcpProcess.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      mcpProcess.on('error', (err) => {
        clearTimeout(timeout);
        console.error('humio-mcp process error:', err);
        resolve({
          statusCode: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'MCP server failed to start' }),
        });
      });

      mcpProcess.on('close', (code) => {
        clearTimeout(timeout);

        if (code !== 0 && code !== null) {
          console.error(`humio-mcp exited with code ${code}: ${errorOutput}`);
          return resolve({
            statusCode: 502,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: 'MCP server error' }),
          });
        }

        if (output) {
          return resolve({
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: output,
          });
        }

        return resolve({
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
      });

      // Send request to humio-mcp stdin
      if (mcpProcess.stdin) {
        mcpProcess.stdin.write(body);
        mcpProcess.stdin.end();
      }
    });
  } catch (error: any) {
    console.error('Unexpected error:', error);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
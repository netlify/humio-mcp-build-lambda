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

    console.log('humio-mcp request:', body);

    // JSON-RPC notifications (no "id" field) never get a response -- most
    // notably notifications/initialized, sent right after initialize as
    // part of the MCP handshake. Waiting for stdout on those would hang
    // until our own timeout, since the server correctly never writes
    // anything back.
    let isNotification = false;
    try {
      const parsed = JSON.parse(body);
      isNotification = !Array.isArray(parsed) && parsed !== null && typeof parsed === 'object' && !('id' in parsed);
    } catch {
      // Not valid JSON -- let humio-mcp itself produce the JSON-RPC parse error.
    }

    // humio-mcp ships as a Node/ESM entry point in the Lambda layer
    // (/opt/dist/index.js), not a standalone executable -- run it with the
    // same node binary executing this handler.
    const mcpProcess = spawn(process.execPath, ['/opt/dist/index.js'], {
      env: {
        ...process.env,
        HUMIO_API_TOKEN,
        HUMIO_REQUEST_TIMEOUT_MS: String(HUMIO_REQUEST_TIMEOUT_MS),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: HUMIO_REQUEST_TIMEOUT_MS + 5000, // Add 5s buffer for cleanup
    });

    // Collect output
    let output = '';
    let errorOutput = '';
    let settled = false;

    return new Promise((resolve) => {
      const finish = (result: APIGatewayProxyResultV2) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        // humio-mcp's stdio transport is a long-lived server loop -- it
        // won't exit on its own after one response, so kill it once we
        // have what we need rather than waiting for natural exit.
        mcpProcess.kill();
        resolve(result);
      };

      // Set up timeout
      const timeout = setTimeout(() => {
        finish({
          statusCode: 504,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'MCP server timed out' }),
        });
      }, HUMIO_REQUEST_TIMEOUT_MS);

      mcpProcess.stdout?.on('data', (data) => {
        output += data.toString();

        // MCP's stdio transport writes newline-delimited JSON-RPC
        // messages. Resolve as soon as we have one complete line instead
        // of closing stdin and waiting for the process to exit -- ending
        // stdin immediately after writing races the child's async
        // response generation against transport teardown.
        const newlineIndex = output.indexOf('\n');
        if (newlineIndex !== -1) {
          const line = output.slice(0, newlineIndex);
          console.log('humio-mcp stdout:', line);
          if (errorOutput) {
            console.log('humio-mcp stderr:', errorOutput);
          }
          finish({
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: line,
          });
        }
      });

      mcpProcess.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      mcpProcess.on('error', (err) => {
        console.error('humio-mcp process error:', err);
        finish({
          statusCode: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: 'MCP server failed to start' }),
        });
      });

      mcpProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`humio-mcp exited with code ${code}: ${errorOutput}`);
        }
        finish({
          statusCode: code === 0 || code === null ? 200 : 502,
          headers: { 'content-type': 'application/json' },
          body: output || JSON.stringify({ error: 'MCP server produced no output', stderr: errorOutput }),
        });
      });

      // Send request to humio-mcp stdin. Deliberately not calling
      // stdin.end() -- see finish() above.
      if (mcpProcess.stdin) {
        mcpProcess.stdin.write(body.endsWith('\n') ? body : body + '\n');
      }

      if (isNotification) {
        finish({ statusCode: 202, headers: { 'content-type': 'application/json' }, body: '' });
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
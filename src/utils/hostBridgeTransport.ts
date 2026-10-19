import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Transport } from '@modelcontextprotocol/server';

type Parameters = ConstructorParameters<typeof StdioClientTransport>[0];
const bridged = new WeakSet<Transport>();

export const isHostBridgeTransport = (transport: Transport): boolean => bridged.has(transport);

/** Wait for verified native cleanup before the SDK tears down its container relay. */
export function createStdioClientTransport(parameters: Parameters): StdioClientTransport {
  const [script, flag, server] = parameters.args ?? [];
  const bridge =
    parameters.args?.length === 3 &&
    script &&
    path.isAbsolute(script) &&
    path.basename(script) === 'host-mcp-relay.mjs' &&
    flag === '--server' &&
    !!server &&
    !!parameters.env?.MCP_GATEWAY_BRIDGE_TOKEN_FILE;
  if (!bridge) return new StdioClientTransport(parameters);

  const session = randomUUID();
  const env = { ...parameters.env, MCP_GATEWAY_BRIDGE_SESSION_ID: session };
  const transport = new StdioClientTransport({ ...parameters, env });
  const close = transport.close.bind(transport);
  let closing: Promise<void> | undefined;
  transport.close = () => {
    if (!closing) {
      closing = new Promise<void>((resolve, reject) => {
        execFile(
          parameters.command,
          [script, '--release-session', session],
          { env, timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true },
          (error) => {
            // The child may emit upstream stderr. Expose only a fixed diagnostic.
            if (error) reject(new Error('Host MCP cleanup was not verified'));
            else resolve();
          },
        );
      })
        .then(close)
        .catch((error: unknown) => {
          closing = undefined;
          throw error;
        });
    }
    return closing;
  };
  bridged.add(transport);
  return transport;
}

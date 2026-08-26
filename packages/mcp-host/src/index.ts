/**
 * @archspace/mcp-host — the engine host's MCP client pool, and the machinery
 * that turns a server's `tools/list` into node types (ARCHITECTURE §9 /
 * ADR-0009).
 *
 * Three audiences import this package and they want different halves of it, so
 * the surface is grouped rather than alphabetised:
 *
 *  - the **engine host** (`packages/app/src/engine-child`, `packages/cli`)
 *    wants `createMcpHost` and `McpServerStatus`;
 *  - the **settings layer** (Electron main, the CLI's config loader) wants only
 *    the `mcp.yaml` codec — it must never pull a client into the main process;
 *  - **tests and tooling** want the pure pieces (`toolToManifest`,
 *    `captureToolResult`, `classifyFailure`) with no server in sight.
 *
 * Everything is re-exported from one entry because the package is small and a
 * subpath map (`@archspace/mcp-host/config`) would only buy the illusion of a
 * boundary: this is all one contract, and the ESLint rule that keeps Electron
 * out of every package below the Electron shell is what actually enforces the
 * split that matters.
 */

// The client pool: lazy connect, generated nodes, status for the UI (§9.2–9.3).
export { createMcpHost } from './host.js';
export type {
  CreateMcpHostOptions,
  McpConnectionState,
  McpHost,
  McpServerStatus,
  McpToolDrift,
  McpToolSummary,
} from './host.js';

// One connection, and the seams the tests drive it through (ADR-0013 §5).
export { openConnection, listServerTools } from './connection.js';
export type { ConnectionDeps, LogFn, OpenConnection, TransportFactory } from './connection.js';

// mcp.yaml: logical name → binding, the split that keeps workflows shareable.
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SERVER_CONCURRENCY,
  MCP_CONFIG_FILENAME,
  defaultMcpConfig,
  describeBinding,
  isValidServerName,
  parseMcpConfig,
  sameServerConfig,
  serializeMcpConfig,
} from './config.js';
export type {
  ConfigIssue,
  McpBinding,
  McpConfig,
  McpHttpBinding,
  McpServerConfig,
  McpStdioBinding,
  McpTransportKind,
} from './config.js';

// tools/list → NodeManifest, and the drift hash that pins it (ADR-0009 §3, §5).
export {
  asJsonSchemaObject,
  canonicalJson,
  hashToolSchema,
  mcpNodeType,
  schemaTypeToPortType,
  toolNameToTypeSegment,
  toolToManifest,
} from './manifest.js';
export type { McpToolInfo } from './manifest.js';

// Tool results → wire values, with bulk content captured into the CAS (§11).
export { captureToolResult, formatTagFor, toValue } from './content.js';
export type { McpToolCallOutcome, RawToolResult } from './content.js';

// One place decides what "transient" means, so retry is a fact not a guess.
export { McpCallError, McpConnectionError, McpHostError, McpToolFailure, classifyFailure } from './errors.js';
export type { FailureClassification } from './errors.js';

// OAuth 2.1/PKCE, delegated: the browser and the keychain live in the app.
export { MCP_OAUTH_REDIRECT_URI, OAUTH_REDIRECT_PORT, createOAuthProvider } from './oauth.js';
export type { DelegatedOAuthProvider, McpOAuthDelegate, OAuthStoreSlot } from './oauth.js';

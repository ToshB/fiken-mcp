export const PUBLIC_ORIGIN = "https://fiken-mcp.flipperselskapet.workers.dev";

/** Canonical RFC 8707 resource, and the URL users add to their MCP client. */
export const MCP_RESOURCE = `${PUBLIC_ORIGIN}/mcp`;

export const SCOPE_READ = "fiken:read";
export const SCOPE_WRITE = "fiken:write";

/**
 * Only Claude and ChatGPT may connect. Both sign in with a Client ID Metadata Document, whose
 * client ID is an HTTPS URL on a domain they control.
 */
export const ALLOWED_CLIENT_ID_PREFIXES = ["https://claude.ai/oauth/", "https://chatgpt.com/oauth/"] as const;

export const FIKEN_AUTHORIZE_URL = "https://fiken.no/oauth/authorize";
export const FIKEN_TOKEN_URL = "https://fiken.no/oauth/token";
export const FIKEN_API_BASE = "https://api.fiken.no/api/v2";
export const FIKEN_REDIRECT_URI = `${PUBLIC_ORIGIN}/callback`;

export function isAllowedClient(clientId: string): boolean {
  return ALLOWED_CLIENT_ID_PREFIXES.some((prefix) => clientId.startsWith(prefix));
}

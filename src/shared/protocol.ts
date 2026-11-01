export const CHATGPT_ORIGIN = 'https://chatgpt.com';
export const CHATGPT_MATCH = `${CHATGPT_ORIGIN}/*`;
export const CONTENT_SCRIPT_ID = 'akm-chatgpt-a0';
export const PROTOCOL_VERSION = 1;
export const MAX_SELECTION_BYTES = 256 * 1024;
export const MAX_FRAGMENTS = 32;

export type Command =
  | { protocolVersion: 1; type: 'GetStatus' }
  | { protocolVersion: 1; type: 'SetProviderEnabled'; enabled: boolean }
  | { protocolVersion: 1; type: 'OpenPreviewDiagnostic'; code: 'PERMISSION_DENIED' }
  | { protocolVersion: 1; type: 'AuthorizePreview'; route: string };

export type Status = { enabled: boolean; granted: boolean; registered: boolean; milestone: 'A6' };
export type Reply = { ok: true; status?: Status } | { ok: false; code: string };

export function parseCommand(value: unknown): Command | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (obj.protocolVersion !== PROTOCOL_VERSION) return null;
  const keys = Object.keys(obj).sort().join(',');
  if (obj.type === 'GetStatus' && keys === 'protocolVersion,type') return obj as Command;
  if (obj.type === 'SetProviderEnabled' && typeof obj.enabled === 'boolean' && keys === 'enabled,protocolVersion,type') return obj as Command;
  if (obj.type === 'OpenPreviewDiagnostic' && obj.code === 'PERMISSION_DENIED' && keys === 'code,protocolVersion,type') return obj as Command;
  if (obj.type === 'AuthorizePreview' && typeof obj.route === 'string' && obj.route.length <= 2048 && keys === 'protocolVersion,route,type') return obj as Command;
  return null;
}

export function conversationIdentity(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== CHATGPT_ORIGIN) return null;
    const match = /^\/(?:c|g\/[^/]+\/c)\/([a-zA-Z0-9-]+)\/?$/.exec(parsed.pathname);
    return match?.[1] ?? null;
  } catch { return null; }
}

export function canonicalRoute(url: string): string | null {
  if (!conversationIdentity(url)) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

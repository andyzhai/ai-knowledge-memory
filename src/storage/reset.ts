import Dexie from 'dexie';
import { activeRepository, closeRepository } from './repository';
import { digest, fail, type SaveResult } from '../shared/knowledge';
import type { DeleteCommand } from '../shared/management';
import { freshIntent } from './management';

type Confirm = Extract<DeleteCommand, { type: 'DeleteLibraryData' }>;
type Reset = { requestId: string; payloadDigest: string; newGeneration: string };
export async function clearDerivedCaches() {
  for (const name of await caches.keys()) await caches.delete(name);
}
export async function resetReceipt(command: Confirm): Promise<SaveResult | undefined> {
  freshIntent(command.issuedAt);
  const { lastReset } = await chrome.storage.local.get('lastReset') as { lastReset?: Reset & { result: SaveResult } };
  if (lastReset?.requestId !== command.requestId) return;
  if (lastReset.payloadDigest !== await digest(command)) fail('REQUEST_ID_REUSED');
  return { ...lastReset.result, deduplicated: true };
}
export async function resetLibrary(command?: Confirm): Promise<SaveResult | undefined> {
  let { resetOperation } = await chrome.storage.local.get('resetOperation') as { resetOperation?: Reset };
  if (!resetOperation) {
    if (!command) return;
    resetOperation = { requestId: command.requestId, payloadDigest: await digest(command), newGeneration: crypto.randomUUID() };
    // Persist recovery intent before removing any pointer, setting or database.
    await chrome.storage.local.set({ resetOperation });
  }
  const reset = resetOperation;
  await closeRepository();
  const settings = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(settings).filter(key => key !== 'resetOperation'));
  for (const name of await Dexie.getDatabaseNames()) if (/^akm-library-/.test(name)) await Dexie.delete(name);
  await clearDerivedCaches(); await chrome.storage.session.clear();
  await chrome.storage.local.set({ activeLibrary: { generation: reset.newGeneration, ready: false } });
  const repo = await activeRepository(true), meta = await repo.checkReady();
  const result: SaveResult = { requestId: reset.requestId, generation: repo.generation, knowledgeId: reset.requestId, recordVersion: 1, dataSeq: meta.dataSeq,
    warnings: [], deduplicated: false, removed: true };
  await chrome.storage.local.set({ lastReset: { ...reset, result } });
  await chrome.storage.local.remove('resetOperation');
  return result;
}

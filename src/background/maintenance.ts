import { activeRepository } from '../storage/repository';
import { resumeDeletion } from '../storage/deletion';
import { clearDerivedCaches, resetLibrary } from '../storage/reset';
import { recoverRestore } from '../storage/backup';
import { pauseViews, resumeViews } from './views';
import { clearBackupTransfers } from './backup-service';
import { PROVIDER_EPOCH, invalidateProviderAccess, reconcile } from './provider';

export async function cancelCaptures() {
  clearBackupTransfers();
  invalidateProviderAccess();
  await chrome.storage.local.set({ [PROVIDER_EPOCH]: crypto.randomUUID() });
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    if (tab.id !== undefined) await chrome.tabs.sendMessage(tab.id, { type: 'ClearPendingCaptures' }, { frameId: 0 }).catch(() => undefined);
  }));
}
export async function recoverDeletion() {
  const reset = await chrome.storage.local.get('resetOperation');
  if (reset.resetOperation) { await pauseViews('reset'); await resetLibrary(); await reconcile(); resumeViews('All local data removed. ChatGPT capture is off until you enable it again.'); return; }
  const restoreNotice = await recoverRestore();
  if (restoreNotice) { await reconcile(); resumeViews(restoreNotice); }
  const repo = await activeRepository(), meta = await repo.db.meta.get('library');
  if (!meta?.deletion) return;
  await pauseViews(meta.deletion.command.requestId); await cancelCaptures();
  if (meta.deletion.command.target.kind === 'all') { await resetLibrary(meta.deletion.command); await reconcile(); }
  else { await resumeDeletion(repo); await clearDerivedCaches(); }
  resumeViews('Deletion completed. Local views have been refreshed.');
}

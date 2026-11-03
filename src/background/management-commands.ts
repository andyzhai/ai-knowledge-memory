import type { ManageNote, DeleteCommand, ManagementReply } from '../shared/management';
import type { Reply } from '../shared/protocol';
import { libraryError, fail } from '../shared/knowledge';
import { activeRepository } from '../storage/repository';
import { manageNote } from '../storage/management';
import { beginDeletion, previewDeletion, resumeDeletion } from '../storage/deletion';
import { clearDerivedCaches, resetLibrary, resetReceipt } from '../storage/reset';
import { pauseViews, resumeViews } from './views';
import { isUi } from './authorization';
import { cancelCaptures } from './maintenance';
import { reconcile } from './provider';
import { serialize } from './queue';

export async function handleManagement(management: ManageNote | DeleteCommand, sender: chrome.runtime.MessageSender): Promise<ManagementReply | Reply> {
  if (!isUi(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT' };
  try {
    return await serialize(async () => {
      if (management.type === 'DeleteLibraryData' && management.target.kind === 'all') {
        const receipt = await resetReceipt(management); if (receipt) return { ok: true as const, result: receipt };
      }
      const repo = await activeRepository();
      if (management.generation !== repo.generation) fail('GENERATION_CHANGED');
      if (management.type === 'PreviewDeletion') return { ok: true as const, preview: await previewDeletion(repo, management.target) };
      if (management.type !== 'DeleteLibraryData') return { ok: true as const, result: await manageNote(repo, management) };
      // Clear and terminate each connected view before admitting deletion.
      // A durable fence then hides all reads until every batch has committed.
      try {
        await pauseViews(management.requestId); await cancelCaptures();
        const prior = await beginDeletion(repo, management);
        const result = management.target.kind === 'all' ? await resetLibrary(management) : prior ?? await resumeDeletion(repo);
        await clearDerivedCaches();
        if (management.target.kind === 'all') await reconcile();
        if (!result) fail('WRITE_FAILED');
        resumeViews(management.target.kind === 'all' ? 'All local data removed. ChatGPT capture is off until you enable it again.' : 'Deletion completed. Shared or independently retained Archive content remains.');
        return { ok: true as const, result };
      } catch (error) {
        // Keep the UI fenced on interrupted work. Recovery is an explicit
        // action and also runs at worker startup, before admitting readers.
        if (!(await repo.db.meta.get('library').catch(() => undefined))?.deletion && !(await chrome.storage.local.get('resetOperation')).resetOperation) resumeViews(libraryError(error).message);
        throw error;
      }
    });
  } catch (error) { return libraryError(error); }
}


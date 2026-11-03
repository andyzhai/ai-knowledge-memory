import { canonicalRoute } from '../shared/protocol';
import { libraryError, fail } from '../shared/knowledge';
import type { CurationCommand, CurationReply, CurationOwner } from '../shared/curation';
import { activeRepository } from '../storage/repository';
import { prepareSelection, curate, selectionReceipt, actOnSelection, identifyCaller } from '../storage/curation';
import { clearDerivedCaches } from '../storage/reset';
import { pauseViews, resumeViews } from './views';
import { isUi, sourceBinding, checkIntent } from './authorization';
import { providerEpoch, getAccessRevision } from './provider';
import { cancelCaptures } from './maintenance';
import { serialize } from './queue';

export async function handleCuration(curationCommand: CurationCommand, sender: chrome.runtime.MessageSender): Promise<CurationReply> {
  try {
    if (curationCommand.type === 'CurateSelection') {
      const admittedRevision = getAccessRevision();
      const binding = await sourceBinding(sender, curationCommand.snapshot.sourceUrl, curationCommand.nonce);
      if (await providerEpoch() !== curationCommand.providerEpoch) fail('PROVIDER_STATE_CHANGED');
      await checkIntent(binding);
      const prepared = await prepareSelection(curationCommand, binding);
      // Preparation does not hold the settings queue. Disable/revoke can
      // invalidate a pending capture while hashes are being computed.
      return await serialize(async () => {
        await sourceBinding(sender, binding.route, binding.nonce);
        if (await providerEpoch() !== curationCommand.providerEpoch) fail('PROVIDER_STATE_CHANGED');
        await checkIntent(binding);
        if (admittedRevision !== getAccessRevision()) fail('PROVIDER_STATE_CHANGED');
        return { ok: true as const, result: await curate(await activeRepository(), prepared) };
      });
    }
    return await serialize(async () => {
      if (curationCommand.type === 'BeginSelection') {
        const binding = await sourceBinding(sender, curationCommand.route, curationCommand.nonce);
        await checkIntent(binding);
        return { ok: true as const, generation: (await activeRepository()).generation, providerEpoch: await providerEpoch() };
      }
      const repo = await activeRepository();
      let caller: CurationOwner | undefined;
      if (!isUi(sender)) {
        const receipt = await repo.db.requestReceipts.get(curationCommand.savedRequestId);
        if (!receipt?.caller || sender.tab?.id === undefined) fail('UNAUTHORIZED_CONTEXT');
        const tab = await chrome.tabs.get(sender.tab.id);
        const route = canonicalRoute(tab.url ?? '');
        if (!route) fail('UNAUTHORIZED_CONTEXT');
        caller = await identifyCaller(await sourceBinding(sender, route, receipt.caller.nonce));
      }
      const receipt = await selectionReceipt(repo, curationCommand.generation, curationCommand.savedRequestId, caller);
      if (curationCommand.type === 'OpenSelection') {
        if (receipt.invalidated) fail('RESULT_REMOVED');
        await chrome.tabs.create({ url: chrome.runtime.getURL(`library.html?note=${receipt.result.knowledgeId}`) });
        return { ok: true as const };
      }
      if (curationCommand.type === 'UndoSelection') {
        try {
          await pauseViews(curationCommand.requestId); await cancelCaptures();
          const result = await actOnSelection(repo, curationCommand, caller);
          await clearDerivedCaches(); resumeViews('Undone. Shared or independently retained sources remain.');
          return { ok: true as const, result };
        } catch (error) { resumeViews(libraryError(error).message); throw error; }
      }
      return { ok: true as const, result: await actOnSelection(repo, curationCommand, caller) };
    });
  } catch (error) { return libraryError(error); }
}


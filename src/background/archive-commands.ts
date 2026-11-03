import { CHATGPT_MATCH, canonicalRoute, type Reply } from '../shared/protocol';
import { libraryError, fail, canonicalJson, RETRY_HORIZON_MS, type LibraryReply } from '../shared/knowledge';
import type { CaptureCommand, CaptureReply, ArchiveOpen, ArchiveRead, ArchiveReply } from '../shared/loaded-capture';
import { activeRepository } from '../storage/repository';
import { prepareCapture, commitCapture, interruptOrphan, readArchive } from '../storage/loaded-capture';
import { identifyCaller } from '../storage/curation';
import { isUi, sourceBinding, checkIntent } from './authorization';
import { status, providerEpoch, getAccessRevision } from './provider';
import { serialize } from './queue';

export async function recoverCaptures(): Promise<void> {
  const repo = await activeRepository();
  const sessions = await repo.db.captures.filter(c => c.scope === 'loaded_conversation' && c.captureStatus === 'in_progress').toArray();
  for (const capture of sessions) {
    try {
      if (!capture.owner || !(await status()).enabled || capture.providerEpoch !== await providerEpoch()) fail('PROVIDER_STATE_CHANGED');
      if (!capture.issuedAt || Date.now() - Date.parse(capture.issuedAt) >= RETRY_HORIZON_MS) fail('INTENT_EXPIRED');
      const conversation = await repo.db.conversations.get(capture.conversationId);
      const route = conversation?.canonicalUrl;
      const tab = await chrome.tabs.get(capture.owner.tabId);
      if (!route || canonicalRoute(tab.url ?? '') !== route || (tab.pendingUrl && canonicalRoute(tab.pendingUrl) !== route)) fail('NAVIGATION_CHANGED');
      await checkIntent({ ...capture.owner, route }, true);
    } catch {
      await interruptOrphan(repo, capture.id, 'source_session_unavailable');
      const meta = await repo.checkReady();
      void chrome.runtime.sendMessage({ type: 'KnowledgeChanged', generation: repo.generation, dataSeq: meta.dataSeq }).catch(() => undefined);
    }
  }
}

export async function handleCapture(captureCommand: CaptureCommand, sender: chrome.runtime.MessageSender): Promise<CaptureReply> {
  try {
    const admitted = getAccessRevision();
    const binding = await sourceBinding(sender, captureCommand.route, captureCommand.nonce);
    await checkIntent(binding, true);
    if (captureCommand.type === 'BeginLoadedCapture') return { ok: true, generation: (await activeRepository()).generation, providerEpoch: await providerEpoch() };
    if (await providerEpoch() !== captureCommand.providerEpoch) fail('PROVIDER_STATE_CHANGED');
    const prepared = await prepareCapture(captureCommand, binding);
    return await serialize(async () => {
      await sourceBinding(sender, binding.route, binding.nonce);
      if (await providerEpoch() !== captureCommand.providerEpoch || admitted !== getAccessRevision()) fail('PROVIDER_STATE_CHANGED');
      await checkIntent(binding, true);
      return { ok: true as const, progress: await commitCapture(await activeRepository(), prepared) };
    });
  } catch (error) { return libraryError(error); }
}

export async function openArchiveCapture(openArchive: ArchiveOpen, sender: chrome.runtime.MessageSender): Promise<Reply> {
  try {
    return await serialize(async () => {
      const repo = await activeRepository(); await repo.checkReady();
      if (repo.generation !== openArchive.generation) fail('GENERATION_CHANGED');
      const capture = await repo.db.captures.get(openArchive.captureId);
      if (!capture) fail('NOT_FOUND');
      if (!isUi(sender)) {
        if (!capture.owner) fail('UNAUTHORIZED_CONTEXT');
        if (sender.tab?.id === undefined) fail('UNAUTHORIZED_CONTEXT');
        const tab = await chrome.tabs.get(sender.tab.id);
        const route = canonicalRoute(tab.url ?? '');
        if (!route) fail('UNAUTHORIZED_CONTEXT');
        const caller = await identifyCaller(await sourceBinding(sender, route, capture.owner.nonce));
        if (canonicalJson(caller) !== canonicalJson(capture.owner)) fail('UNAUTHORIZED_CONTEXT');
      }
      if (capture.captureStatus !== 'completed') fail('CAPTURE_INCOMPLETE');
      // Web-origin links cannot navigate to private extension pages. Keep the
      // library private and open only this persisted result from our worker.
      await chrome.tabs.create({ url: chrome.runtime.getURL(`library.html?capture=${capture.id}`) });
      return { ok: true as const };
    });
  } catch (error) { return libraryError(error); }
}

export async function handleArchiveRead(archiveCommand: ArchiveRead, sender: chrome.runtime.MessageSender): Promise<ArchiveReply> {
  if (!isUi(sender)) return { ok: false, code: 'UNAUTHORIZED_CONTEXT', message: 'Archive requires an extension view.', retryable: false };
  try { return await serialize(async () => { await recoverCaptures(); return readArchive(await activeRepository(), archiveCommand); }); }
  catch (error) { return libraryError(error); }
}

export async function verifyOriginalSource(value: { generation: string; sourceId: string }, sender: chrome.runtime.MessageSender): Promise<{ ok: true; location: string } | Extract<LibraryReply, { ok: false }>> {
  try {
    if (!isUi(sender)) fail('UNAUTHORIZED_CONTEXT');
    const repo = await activeRepository(); await repo.checkReady();
    if (repo.generation !== value.generation) fail('GENERATION_CHANGED');
    const source = await repo.db.sourceRefs.get(value.sourceId);
    if (!source) fail('NOT_FOUND');
    if (!(await status()).enabled || !source.sourceUrl || !source.originalPageAnchor || source.sourceRemovedAt) return { ok: true, location: 'unavailable' };
    const tabs = (await chrome.tabs.query({ url: [CHATGPT_MATCH] })).filter(tab => canonicalRoute(tab.url ?? '') === source.sourceUrl && !tab.incognito);
    if (tabs.length !== 1 || tabs[0]?.id === undefined) return { ok: true, location: tabs.length ? 'ambiguous' : 'unavailable' };
    const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'LocateOriginalSource', route: source.sourceUrl, anchor: source.originalPageAnchor }, { frameId: 0 });
    const location = ['verified', 'ambiguous', 'missing', 'changed'].includes(result?.location) ? result.location : 'unavailable';
    return { ok: true, location };
  } catch (error) { return libraryError(error); }
}


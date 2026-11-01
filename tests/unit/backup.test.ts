import { describe, expect, it } from 'vitest';
import { checkBackupSize, makeBackup, markdownFile, markdownZip, MAX_BACKUP_BYTES, parseBackupText, validateBackup, type Records } from '../../src/shared/backup';
import { digest, type KnowledgeItem } from '../../src/shared/knowledge';
import { markdownPlainText } from '../../src/shared/markdown';

async function fixture() {
  const now = new Date().toISOString(), id = crypto.randomUUID();
  const fields = { title: '../CON: Example 知识', bodyMarkdown: 'Text\n\n```ts\nconst x = "中文";\n```', type: 'personal_note' as const, tags: ['tag'], personalExplanation: 'Why', applicableVersion: 'v1', reviewAfter: null };
  const note: KnowledgeItem = { ...fields, id, schemaVersion: 1, createdAt: now, updatedAt: now, recordVersion: 1, plainText: markdownPlainText(fields.bodyMarkdown), contentHash: await digest({ kind: 'knowledge', fields }), canonicalVersion: 1, currentVersion: 1, reviewState: 'saved', reviewedAt: null, supersededById: null, origin: 'manual_note', sourceKind: 'manual', curationKey: null, createdByRequestId: crypto.randomUUID() };
  const records: Records = { connections: [], conversations: [], messages: [], messageRevisions: [], captures: [], sourceRefs: [], knowledgeItems: [note], knowledgeRevisions: [{ id: crypto.randomUUID(), schemaVersion: 1, knowledgeId: id, version: 1, changedAt: now, changeReason: 'created', snapshot: structuredClone(note), sources: [] }] };
  return makeBackup(records, crypto.randomUUID(), 1);
}
describe('portable backup validation', () => {
  it('preserves exact text, IDs and history with deterministic section checksums', async () => {
    const b = await fixture(); expect(await validateBackup(parseBackupText(JSON.stringify(b)))).toEqual(b);
    expect((await makeBackup(b.records, b.libraryId, b.dataSeq)).checksums).toEqual(b.checksums);
  });
  it('rejects counts, checksum, schema, unsafe keys, deep nesting and size before restore', async () => {
    const b = await fixture();
    await expect(validateBackup({ ...b, schemaVersion: 2 })).rejects.toThrow('BACKUP_TOO_NEW');
    await expect(validateBackup({ ...b, counts: { ...b.counts, knowledgeItems: 2 } })).rejects.toThrow('BACKUP_INVALID');
    b.records.knowledgeItems[0]!.title = 'tampered'; await expect(validateBackup(b)).rejects.toThrow('BACKUP_CHECKSUM');
    expect(() => parseBackupText('{"__proto__":{}}')).toThrow('BACKUP_INVALID');
    expect(() => parseBackupText('['.repeat(33) + ']'.repeat(33))).toThrow('BACKUP_INVALID');
    expect(() => parseBackupText('{broken')).toThrow('BACKUP_INVALID');
    expect(() => checkBackupSize(MAX_BACKUP_BYTES)).not.toThrow(); expect(() => checkBackupSize(MAX_BACKUP_BYTES + 1)).toThrow('BACKUP_TOO_LARGE');
    expect(() => checkBackupSize(-1)).toThrow('BACKUP_TOO_LARGE');
  });
  it('does not trust recomputed checksums for invalid hashes, duplicate IDs, references or history', async () => {
    for (const mutate of [
      (r: Records) => { r.knowledgeItems[0]!.contentHash = '0'.repeat(64); },
      (r: Records) => { r.knowledgeItems.push(r.knowledgeItems[0]!); },
      (r: Records) => { r.knowledgeItems[0]!.supersededById = crypto.randomUUID(); },
      (r: Records) => { r.knowledgeRevisions[0]!.version = 2; },
      (r: Records) => { r.knowledgeRevisions[0]!.snapshot.title = 'wrong'; },
    ]) {
      const b = await fixture(); mutate(b.records);
      await expect(validateBackup(await makeBackup(b.records, b.libraryId, b.dataSeq))).rejects.toThrow('BACKUP_INVALID');
    }
  });
  it('exports standalone Markdown with safe unique filenames and a UTF-8 ZIP', async () => {
    const b = await fixture(), n = b.records.knowledgeItems[0]!, file = markdownFile(n, []);
    expect(file.filename).not.toMatch(/[\\/:]/); expect(file.filename).toContain(n.id);
    expect(file.body).toContain(n.bodyMarkdown); expect(file.body).toContain('one-way export'); expect(file.body).toContain('reviewState: "saved"');
    const zip = markdownZip([file]); expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new DataView(zip.buffer).getUint16(12, true)).toBe(0x21);
    expect(new TextDecoder().decode(zip)).toContain(file.body); expect(new DataView(zip.buffer).getUint32(zip.length - 22, true)).toBe(0x06054b50);
  });
});

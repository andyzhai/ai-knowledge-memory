export async function verifyModelAsset(buffer: ArrayBuffer, file: { bytes: number; sha256: string }) {
  if (buffer.byteLength !== file.bytes) throw new Error('Model size mismatch.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== file.sha256) throw new Error('Model checksum mismatch.');
}

import handler from '../api/media-metadata.js';
export async function lookupQueueMetadata(url) {
  let status = 200, body;
  const res = { setHeader() {}, status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  try { await handler({ method: 'GET', query: { url } }, res);return status === 200 ? body : null; }
  catch { return null; }
}

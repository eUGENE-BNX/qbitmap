// Parse `Range: bytes=<start>-<end>` against a known full size. Returns
// { start, end } (inclusive) or null if the header is malformed or the
// request ends up out of range.
export function parseRangeHeader(header, fullSize) {
  if (!header || !fullSize) return null;
  const m = /bytes=(\d*)-(\d*)/i.exec(header);
  if (!m) return null;

  const rawStart = m[1];
  const rawEnd = m[2];

  let start;
  let end;

  if (rawStart === '' && rawEnd !== '') {
    // Suffix range: last N bytes
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, fullSize - suffix);
    end = fullSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? fullSize - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < start) return null;
    if (end >= fullSize) end = fullSize - 1;
  }

  if (start >= fullSize) return null;
  return { start, end };
}

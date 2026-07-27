(function scannerUtilsFactory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YsmScannerUtils = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16}$/;
  const INVALID_MESSAGE = '不是有效的优胜美设备铭牌二维码';

  function extractScanToken(value) {
    const raw = String(value ?? '').trim();
    if (!raw) throw new Error(INVALID_MESSAGE);

    let candidate = raw;
    try {
      const parsed = new URL(raw, 'https://scanner.invalid/');
      const fromQuery = parsed.searchParams.get('scan');
      if (fromQuery !== null) candidate = fromQuery.trim();
      else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('?')) {
        throw new Error(INVALID_MESSAGE);
      }
    } catch (error) {
      if (error.message === INVALID_MESSAGE) throw error;
    }

    if (!TOKEN_PATTERN.test(candidate)) throw new Error(INVALID_MESSAGE);
    return candidate;
  }

  return { extractScanToken };
}));

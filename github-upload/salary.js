/* Decode salary glyphs locally using the font currently rendered by the page. */
(function (scope) {
  'use strict';
  const encoded = value => /[\uE000-\uF8FF\uFFFD]/.test(String(value || ''));
  const cache = new Map();
  function bestMatch(glyph, candidates) {
    if (!glyph?.pixels?.length) return null;
    const scores = candidates.map(candidate => {
      if (!candidate.pixels || candidate.pixels.length !== glyph.pixels.length || Math.abs(candidate.aspect - glyph.aspect) > 0.04) return { digit: candidate.digit, score: 0 };
      let delta = 0, ink = 0;
      for (let i = 0; i < glyph.pixels.length; i++) { delta += Math.abs(glyph.pixels[i] - candidate.pixels[i]); ink += Math.max(glyph.pixels[i], candidate.pixels[i]); }
      return { digit: candidate.digit, score: ink ? 1 - delta / ink : 0 };
    });
    // Compare distinct digits; multiple reference fonts can contain the same shape.
    const digits = new Map();
    for (const item of scores) if ((digits.get(item.digit) || 0) < item.score) digits.set(item.digit, item.score);
    const ranked = [...digits].map(([digit, score]) => ({ digit, score })).sort((a, b) => b.score - a.score);
    return ranked[0]?.score >= 0.985 && ranked[0].score - (ranked[1]?.score || 0) >= 0.04 ? ranked[0].digit : null;
  }
  function decode(value, mapping) {
    return String(value || '').replace(/[\uE000-\uF8FF]/g, char => /^[0-9]$/.test(mapping[char] || '') ? mapping[char] : char);
  }
  function raster(char, font, doc) {
    const canvas = doc.createElement('canvas'); canvas.width = 140; canvas.height = 120;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return null;
    ctx.font = font; ctx.fillStyle = '#000'; ctx.fillText(char, 12, 90);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let left = canvas.width, top = canvas.height, right = -1, bottom = -1;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (image.data[(y * canvas.width + x) * 4 + 3] <= 8) continue;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    if (right < left || bottom < top) return null;
    const width = right - left + 1, height = bottom - top + 1;
    const sample = doc.createElement('canvas'); sample.width = 32; sample.height = 48;
    const context = sample.getContext('2d', { willReadFrequently: true });
    context.drawImage(canvas, left, top, width, height, 0, 0, 32, 48);
    const data = context.getImageData(0, 0, 32, 48).data;
    return { aspect: width / height, pixels: Array.from({ length: 32 * 48 }, (_, i) => data[i * 4 + 3] / 255) };
  }
  function read(element) {
    if (!element) return '';
    const raw = element.textContent.trim();
    if (!encoded(raw)) return raw;
    for (const attribute of ['aria-label', 'title', 'data-salary']) {
      const value = element.getAttribute(attribute);
      if (value && !encoded(value) && scope.BossCore?.monthlySalary(value)) return value;
    }
    const doc = element.ownerDocument;
    const style = doc.defaultView.getComputedStyle(element);
    const prefix = style.fontStyle + ' ' + style.fontWeight + ' 72px ';
    const font = prefix + style.fontFamily;
    const key = font;
    let mapping = cache.get(key);
    if (!mapping) {
      mapping = {};
      const families = [...new Set([style.fontFamily, 'Arial', '"Microsoft YaHei"', 'sans-serif'])];
      const references = families.flatMap(family => Array.from({ length: 10 }, (_, i) => ({ digit: String(i), ...raster(String(i), prefix + family, doc) })));
      for (const char of new Set(raw.match(/[\uE000-\uF8FF]/g) || [])) {
        const digit = bestMatch(raster(char, font, doc), references);
        if (digit !== null) mapping[char] = digit;
      }
      if (doc.fonts?.status === 'loaded') cache.set(key, mapping);
    } else {
      // Lazily decode digits that were absent from the first salary on this page.
      for (const char of new Set(raw.match(/[\uE000-\uF8FF]/g) || [])) {
        if (mapping[char]) continue;
        const references = [style.fontFamily, 'Arial', '"Microsoft YaHei"', 'sans-serif'].flatMap(family => Array.from({ length: 10 }, (_, i) => ({ digit: String(i), ...raster(String(i), prefix + family, doc) })));
        const digit = bestMatch(raster(char, font, doc), references);
        if (digit !== null) mapping[char] = digit;
      }
    }
    return decode(raw, mapping);
  }
  scope.document?.fonts?.addEventListener('loadingdone', () => cache.clear());
  const api = { encoded, decode, bestMatch, read };
  scope.BossSalary = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);

// Driver photos, team logos and car pictures (F1's public images, cached by the laptop).
// Everything falls back gracefully: a missing image just isn't shown.

const parts = (d) => String(d?.PublicIdRight || '').split('/'); // common/f1/2026/mercedes/georus01/2026mercedesgeorus01right

export function headshot(d) {
  if (d?.PublicIdRight) return `/api/img?t=face&id=${encodeURIComponent(d.PublicIdRight)}`;
  return d?.HeadshotUrl || null;
}

export function teamSlug(d) {
  const p = parts(d);
  return p.length >= 4 ? p[3] : null;
}

function teamAsset(d, name, t) {
  const p = parts(d);
  if (p.length < 4) return null;
  const [, , year, slug] = p;
  return `/api/img?t=${t}&id=${encodeURIComponent(`common/f1/${year}/${slug}/${year}${slug}${name}`)}`;
}

/** White logo on the dark theme, coloured/black on the light one. */
export const teamLogo = (d) => teamAsset(d, document.body.dataset.theme === 'paper' ? 'logo' : 'logowhite', 'logo');
export const carImage = (d) => teamAsset(d, 'carright', 'car');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** <img> that hides itself if it can't load. */
export function img(src, cls, alt = '') {
  if (!src) return '';
  return `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" onerror="this.remove()">`;
}

/** Round driver photo with a team-colour ring. */
export function avatar(d, cls = 'av') {
  const src = headshot(d);
  return src ? `<span class="${cls}" style="--tc:#${esc(d?.TeamColour || '777')}">${img(src, '', d?.Tla || '')}</span>` : '';
}

// ============================================================
// Vault — Gradient Avatar Generator (Memoized)
// ============================================================

const gradientCache = new Map();

export function getAvatarGradient(username) {
  if (!username) return 'linear-gradient(135deg, #1f1f2e, #11111b)';
  if (gradientCache.has(username)) return gradientCache.get(username);

  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 120) % 360;
  // Tailored HSL values: 65% saturation and 45%/25% lightness yield sleek dark-mode dual gradients
  const gradient = `linear-gradient(135deg, hsl(${h1}, 65%, 45%), hsl(${h2}, 60%, 25%))`;
  gradientCache.set(username, gradient);
  return gradient;
}

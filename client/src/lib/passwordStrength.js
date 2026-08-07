// Shared by Auth.svelte's registration form and PassphrasePromptModal.svelte
// — both ask someone to invent a new secret, so both get the same strength
// read rather than one being a bare unvalidated text field.
export function estimatePasswordStrength(pw) {
  if (!pw) return { score: 0, label: '', color: '' };

  let variety = 0;
  if (/[a-z]/.test(pw)) variety++;
  if (/[A-Z]/.test(pw)) variety++;
  if (/[0-9]/.test(pw)) variety++;
  if (/[^a-zA-Z0-9]/.test(pw)) variety++;

  let score = 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (pw.length >= 24) score++;
  if (variety >= 3) score++;

  const uniqueRatio = new Set(pw).size / pw.length;
  if (uniqueRatio < 0.4) score = Math.max(0, score - 2); // heavily repetitive

  score = Math.min(score, 4);
  const levels = [
    { label: 'Too short', color: 'bg-vault-danger' },
    { label: 'Weak', color: 'bg-vault-danger' },
    { label: 'Fair', color: 'bg-vault-warning' },
    { label: 'Good', color: 'bg-vault-accent/70' },
    { label: 'Strong', color: 'bg-vault-accent' },
  ];
  return { score, ...levels[score] };
}

/**
 * Hides most of an e-mail address on screen, so the popup and Settings can be
 * shown or recorded without giving the address away:
 * "jane.doe42@example.com" → "ja*****2@example.com".
 *
 * The number of stars is fixed, so the length of the name is not revealed
 * either. The domain stays readable to tell accounts apart.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return email ? `${email[0]}*****` : '';
  const name = [...email.slice(0, at)];
  const domain = email.slice(at);
  if (name.length <= 2) return `${name[0]}*****${domain}`;
  if (name.length <= 4) return `${name[0]}*****${name.at(-1)}${domain}`;
  return `${name.slice(0, 2).join('')}*****${name.at(-1)}${domain}`;
}

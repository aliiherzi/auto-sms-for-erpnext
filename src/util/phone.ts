/**
 * Phone number clean-up.
 *
 * ERPNext users type numbers in every possible way: "+971 50 123 4567",
 * "050-1234567", "00971501234567", "(050) 123 4567 / 055 7654321".
 * WhatsApp needs international digits only: "971501234567".
 */

/** Returns international digits (no +) or null when the value can't be a phone number. */
export function normalizePhone(raw: string | null | undefined, defaultCountryCode = ''): string | null {
  if (!raw) return null;
  // Use only the first number if several are listed.
  let text = String(raw).split(/[,;/|]|\bor\b/i)[0].trim();
  // Drop extensions such as "ext. 12" or "x12".
  text = text.replace(/\s*(?:ext\.?|extension|x)\s*\d+\s*$/i, '');
  const hasPlus = text.startsWith('+');
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;

  const cc = (defaultCountryCode || '').replace(/\D/g, '');

  if (hasPlus) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    if (!cc) return null; // local number but we don't know the country
    digits = cc + digits.replace(/^0+/, '');
  } else if (cc && digits.length <= 10 && !digits.startsWith(cc)) {
    // Looks like a local number written without the leading 0 (e.g. 501234567).
    digits = cc + digits;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export function isGroupJid(value: string): boolean {
  return value.endsWith('@g.us');
}

export function isJid(value: string): boolean {
  return /@(s\.whatsapp\.net|g\.us|lid|c\.us|broadcast|newsletter)$/.test(value);
}

/** "+971 50 123 4567"-ish display for logs and the dashboard. */
export function displayPhone(digits: string): string {
  return digits ? `+${digits}` : '';
}

export type SensitiveInputContext = {
  actionType?: string;
  selector?: string;
  description?: string;
  fieldHint?: string;
};

function normalizeHint(value: string | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function buildHintText(context?: SensitiveInputContext): string {
  if (!context) return '';
  return [
    normalizeHint(context.actionType),
    normalizeHint(context.selector),
    normalizeHint(context.description),
    normalizeHint(context.fieldHint),
  ]
    .filter(Boolean)
    .join(' ');
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function looksLikeCpf(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 && /^(\d{3}\.?\d{3}\.?\d{3}-?\d{2})$/.test(value);
}

function looksLikeCnpj(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length === 14 && /^(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})$/.test(value);
}

function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return false;
  return /^\+?[\d\s().-]+$/.test(value);
}

function looksLikeMaskedPassword(value: string): boolean {
  return /^[*•●·]+$/.test(value);
}

function looksLikeNumericCode(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 && digits.length <= 8 && digits === value.trim();
}

function hasAny(hint: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(hint));
}

export function redactSensitiveTestInput(rawValue: string, context?: SensitiveInputContext): string {
  if (typeof rawValue !== 'string') return rawValue;
  const value = rawValue.trim();
  if (!value) return rawValue;

  const hint = buildHintText(context);
  const digits = value.replace(/\D/g, '');

  const passwordHint = hasAny(hint, [/\bpassword\b/, /\bsenha\b/, /\bpasscode\b/, /\bsecret\b/]);
  if (passwordHint || looksLikeMaskedPassword(value)) {
    return '${PASSWORD}';
  }

  const tokenHint = hasAny(hint, [/\btoken\b/, /\bapi[-_ ]?key\b/, /\bbearer\b/]);
  if (tokenHint && value.length >= 6) {
    return '${SECRET}';
  }

  const emailHint = hasAny(hint, [/\bemail\b/, /\be-mail\b/]);
  if (emailHint || looksLikeEmail(value)) {
    return '${EMAIL}';
  }

  const cpfHint = hasAny(hint, [/\bcpf\b/, /\bdocumento\b/]);
  if ((cpfHint && digits.length === 11) || looksLikeCpf(value)) {
    return '${CPF}';
  }

  const cnpjHint = hasAny(hint, [/\bcnpj\b/]);
  if ((cnpjHint && digits.length === 14) || looksLikeCnpj(value)) {
    return '${CNPJ}';
  }

  const otpHint = hasAny(hint, [/\botp\b/, /\b2fa\b/, /\bpin\b/, /\bverification\b/, /\bcodigo\b/, /\bcódigo\b/, /\bcode\b/]);
  if (otpHint && looksLikeNumericCode(value)) {
    return hint.includes('pin') ? '${PIN}' : '${OTP_CODE}';
  }

  const phoneHint = hasAny(hint, [/\bphone\b/, /\btelefone\b/, /\bcelular\b/, /\bwhats(app)?\b/, /\btel\b/]);
  if ((phoneHint && digits.length >= 8 && digits.length <= 13) || looksLikePhone(value)) {
    return '${PHONE}';
  }

  const usernameHint = hasAny(hint, [/\busername\b/, /\buser\b/, /\blogin\b/]);
  if (usernameHint) {
    return '${USERNAME}';
  }

  return rawValue;
}

export function redactQuotedStringsInText(rawText: string, context?: SensitiveInputContext): string {
  if (typeof rawText !== 'string' || !rawText) return rawText;
  return rawText.replace(/"([^"]*)"/g, (_match, quoted) => {
    const redacted = redactSensitiveTestInput(String(quoted), context);
    return `"${redacted}"`;
  });
}


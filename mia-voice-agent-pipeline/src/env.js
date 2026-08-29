// Environment loading and validation. Fail fast, with a message that says what to fix.

const PLACEHOLDER = /^your_.+_here$/i;

function raw(name) {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return PLACEHOLDER.test(trimmed) ? '' : trimmed;
}

export function required(name, hint) {
  const value = raw(name);
  if (!value) throw new Error(`${name} is missing from .env. ${hint || ''}`.trim());
  return value;
}

export function optional(name, fallback = '') {
  const value = raw(name);
  return value || fallback;
}

export function optionalBoolean(name, fallback = false) {
  const value = raw(name).toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} in .env must be true or false.`);
}

export function optionalNumber(name, fallback) {
  const value = raw(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} in .env must be a positive number.`);
  return parsed;
}

export function requireHttpsUrl(name, hint) {
  const value = required(name, hint);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a full address starting with https://.`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must start with https://.`);
  return url.href;
}

export function optionalHttpsUrl(name) {
  const value = raw(name);
  if (!value) return '';
  if (!/^https:\/\//i.test(value)) throw new Error(`${name} must be a public address starting with https://.`);
  return value;
}

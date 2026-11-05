/** Tiny argv parser - no dependency needed for a handful of flags. */

export function parseArgs(argv) {
  const positional = [];
  const flags = Object.create(null);
  /** repeated flags collected as arrays */
  const repeated = { set: [], field: [], file: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    let key = token.slice(2);
    let value;

    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    }

    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

    if (Object.prototype.hasOwnProperty.call(repeated, camel)) {
      if (value === undefined) {
        value = argv[i + 1];
        i += 1;
      }
      if (value === undefined) throw new Error(`--${key} needs a value.`);
      repeated[camel].push(value);
      continue;
    }

    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        value = true; // boolean flag
      } else {
        value = next;
        i += 1;
      }
    }

    flags[camel] = value;
  }

  return { positional, flags, ...repeated };
}

/** Coerce "true"/"false"/"123"/"null" into real JSON values; everything else stays a string. */
export function coerce(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

/** Turn `--set key=value` pairs into an object. Use `key:=value` to force a string. */
export function pairsToObject(pairs, { coerceValues = true } = {}) {
  const out = {};
  for (const pair of pairs) {
    const forceString = pair.includes(':=');
    const sep = forceString ? pair.indexOf(':=') : pair.indexOf('=');
    if (sep === -1) {
      throw new Error(`Expected key=value, got "${pair}".`);
    }
    const key = pair.slice(0, sep);
    const raw = pair.slice(sep + (forceString ? 2 : 1));
    if (!key) throw new Error(`Empty key in "${pair}".`);
    out[key] = forceString || !coerceValues ? raw : coerce(raw);
  }
  return out;
}

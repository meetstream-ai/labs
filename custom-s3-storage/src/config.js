import { optionalEnv, requireEnv } from './util.js';

/**
 * Build and validate the StorageConfigRequest body for
 * PUT /admin/configs?config_type=storage.
 *
 * Required by the API: provider, bucket_name, region, access_key_id, secret_key
 * Optional:            access_mode, prefix, prefixes, endpoint_url
 *
 * `secret_key` is a real cloud credential. It is read from the environment,
 * put straight into the request body, and never printed. Everything that
 * displays a config goes through `redactConfig()` first.
 */

/** The only provider the API accepts today. */
export const PROVIDER = 'aws';

/** Query values the API's enums allow. */
export const CONFIG_TYPE = 'storage';
export const KEY_NAME = 'aws';

/** read_write makes MeetStream's fetch endpoints serve media out of your bucket. */
export const ACCESS_MODES = ['read_write', 'write_only'];

/** The API's own default when `prefix` is omitted. Objects are keyed {prefix}/{bot_id}_<file>. */
export const DEFAULT_PREFIX = 'meetstream';

const PREFIX_CATEGORIES = {
  audio: 'S3_PREFIX_AUDIO',
  video: 'S3_PREFIX_VIDEO',
  transcript: 'S3_PREFIX_TRANSCRIPT',
  metadata: 'S3_PREFIX_METADATA',
};

/**
 * A prefix is a key path segment, not a URL. The API strips leading and
 * trailing slashes and rejects ".." segments, so catch those locally with a
 * message that says which variable is wrong.
 *
 * @param {string} value
 * @param {string} varName
 * @returns {string}
 */
function normalizePrefix(value, varName) {
  const trimmed = value.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    throw new Error(`${varName} cannot be only slashes.`);
  }
  if (trimmed.split('/').includes('..')) {
    throw new Error(`${varName} must not contain ".." path segments.`);
  }
  return trimmed;
}

/**
 * Assemble the request body from the environment.
 *
 * @returns {{ config: Record<string, any>, basePrefix: string, prefixes: string[] }}
 *   config      the exact JSON body to PUT
 *   basePrefix  the effective base prefix, including the API default
 *   prefixes    every distinct prefix media can land under, for verification
 */
export function buildStorageConfig() {
  const bucketName = requireEnv('S3_BUCKET');
  const region = requireEnv('S3_REGION');
  const accessKeyId = requireEnv('S3_ACCESS_KEY_ID');
  const secretKey = requireEnv('S3_SECRET_KEY');

  /** @type {Record<string, any>} */
  const config = {
    provider: PROVIDER,
    bucket_name: bucketName,
    region,
    access_key_id: accessKeyId,
    secret_key: secretKey,
  };

  const accessMode = optionalEnv('S3_ACCESS_MODE');
  if (accessMode) {
    if (!ACCESS_MODES.includes(accessMode)) {
      throw new Error(`S3_ACCESS_MODE must be one of ${ACCESS_MODES.join(' | ')} (got "${accessMode}").`);
    }
    config.access_mode = accessMode;
  }

  const rawPrefix = optionalEnv('S3_PREFIX');
  if (rawPrefix) config.prefix = normalizePrefix(rawPrefix, 'S3_PREFIX');

  /** @type {Record<string, string>} */
  const prefixOverrides = {};
  for (const [category, varName] of Object.entries(PREFIX_CATEGORIES)) {
    const raw = optionalEnv(varName);
    if (raw) prefixOverrides[category] = normalizePrefix(raw, varName);
  }
  if (Object.keys(prefixOverrides).length > 0) config.prefixes = prefixOverrides;

  const endpointUrl = optionalEnv('S3_ENDPOINT_URL');
  if (endpointUrl) {
    try {
      void new URL(endpointUrl);
    } catch {
      throw new Error(`S3_ENDPOINT_URL is not a valid URL: "${endpointUrl}"`);
    }
    config.endpoint_url = endpointUrl;
  }

  const basePrefix = config.prefix ?? DEFAULT_PREFIX;
  const prefixes = [...new Set([basePrefix, ...Object.values(prefixOverrides)])];

  return { config, basePrefix, prefixes };
}

/**
 * A copy of a config that is safe to print or log.
 *
 * `secret_key` is removed entirely. `access_key_id` is not secret on its own,
 * but the last four characters are enough to tell two key pairs apart, so the
 * rest is masked too.
 *
 * @param {Record<string, any>} config
 * @returns {Record<string, any>}
 */
export function redactConfig(config) {
  const safe = { ...config };
  if ('secret_key' in safe) safe.secret_key = '<redacted, never logged>';
  if (typeof safe.access_key_id === 'string') {
    const id = safe.access_key_id;
    safe.access_key_id = id.length <= 4 ? '****' : `${'*'.repeat(id.length - 4)}${id.slice(-4)}`;
  }
  return safe;
}

import { HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

import { log } from './log.js';
import { formatBytes } from './util.js';

/**
 * Read-only checks against the customer's own bucket.
 *
 * MeetStream does the writing once the storage config is set. Nothing here
 * uploads anything. These calls exist for two reasons:
 *
 *   1. A local HeadBucket before you send credentials to MeetStream, so a typo
 *      in the bucket name or region surfaces as a clear local error instead of
 *      an opaque 400 from the config endpoint.
 *   2. A ListObjectsV2 after a bot finishes, to prove the media actually landed.
 *      In write_only mode this is the only way to see it: MeetStream's own
 *      fetch endpoints return 403 for media that lives in your bucket.
 *
 * The credentials used here are the same pair you configure MeetStream with,
 * read from S3_ACCESS_KEY_ID / S3_SECRET_KEY.
 */

/**
 * @param {object} opts
 * @param {string} opts.region
 * @param {string} [opts.endpoint] - set for S3-compatible stores (MinIO, R2)
 * @param {boolean} [opts.forcePathStyle]
 * @param {string} [opts.accessKeyId]
 * @param {string} [opts.secretAccessKey]
 * @returns {S3Client}
 */
export function createS3Client({ region, endpoint, forcePathStyle = false, accessKeyId, secretAccessKey }) {
  /** @type {import('@aws-sdk/client-s3').S3ClientConfig} */
  const config = { region };
  if (endpoint) {
    config.endpoint = endpoint;
    config.forcePathStyle = forcePathStyle;
  }
  if (accessKeyId && secretAccessKey) {
    config.credentials = { accessKeyId, secretAccessKey };
  } else {
    log.debug('No explicit S3 keys set - using the SDK default credential chain for local checks.');
  }
  return new S3Client(config);
}

/**
 * Confirm the bucket exists and the credentials can reach it.
 *
 * Run this BEFORE handing the credentials to MeetStream. MeetStream runs its
 * own validation, but a local failure names the problem precisely and does not
 * involve sending a broken credential anywhere.
 *
 * @param {S3Client} s3
 * @param {string} bucket
 * @returns {Promise<void>}
 */
export async function assertBucketAccess(s3, bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    log.info(`Bucket "${bucket}" is reachable with these credentials.`);
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404) {
      throw new Error(`Bucket "${bucket}" does not exist (or is in a different region than S3_REGION).`);
    }
    if (status === 403) {
      throw new Error(
        `Access denied on bucket "${bucket}". The credentials need s3:ListBucket on ` +
          `arn:aws:s3:::${bucket} and s3:PutObject on arn:aws:s3:::${bucket}/*. See the README.`
      );
    }
    throw new Error(`Could not reach bucket "${bucket}": ${err.message}`);
  }
}

/**
 * List whatever MeetStream wrote for one bot.
 *
 * Objects are keyed `{prefix}/{bot_id}_<file>`, so a prefix search on
 * `<prefix>/<bot_id>_` finds every artifact for that bot without scanning the
 * whole bucket. Per-category prefix overrides mean there can be more than one
 * place to look, which is why `prefixes` is a list.
 *
 * @param {object} params
 * @param {S3Client} params.s3
 * @param {string} params.bucket
 * @param {string[]} params.prefixes
 * @param {string} params.botId
 * @returns {Promise<Array<{ key: string, size: number, lastModified?: Date }>>}
 */
export async function listBotObjects({ s3, bucket, prefixes, botId }) {
  /** @type {Map<string, { key: string, size: number, lastModified?: Date }>} */
  const found = new Map();

  for (const prefix of prefixes) {
    const search = `${prefix}/${botId}_`;
    let continuationToken;

    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: search,
          ContinuationToken: continuationToken,
        })
      );

      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        found.set(object.Key, {
          key: object.Key,
          size: object.Size ?? 0,
          lastModified: object.LastModified,
        });
      }

      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Print a listing result.
 * @param {string} bucket
 * @param {Array<{ key: string, size: number }>} objects
 */
export function printObjects(bucket, objects) {
  for (const object of objects) {
    log.info(`  s3://${bucket}/${object.key}  (${formatBytes(object.size)})`);
  }
}

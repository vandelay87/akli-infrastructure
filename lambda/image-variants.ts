export const VARIANT_SUFFIXES = ['thumb', 'medium', 'full'] as const

export type VariantSuffix = (typeof VARIANT_SUFFIXES)[number]

// S3 key prefixes for the image pipeline. Uploads land under UPLOAD_PREFIX
// (what the resizer S3 trigger listens for); processed variants are written
// under PROCESSED_PREFIX (where the site serves `<prefix><name>-<variant>.webp`).
export const UPLOAD_PREFIX = 'uploads/'
export const PROCESSED_PREFIX = 'processed/'

export const toProcessedKey = (uploadKey: string): string => {
  if (!uploadKey.startsWith(UPLOAD_PREFIX)) {
    throw new Error(`Expected key to start with "${UPLOAD_PREFIX}", got "${uploadKey}"`)
  }
  return PROCESSED_PREFIX + uploadKey.slice(UPLOAD_PREFIX.length)
}

export const VARIANT_SUFFIXES = ['thumb', 'medium', 'full'] as const

export type VariantSuffix = (typeof VARIANT_SUFFIXES)[number]

export const UPLOAD_PREFIX = 'uploads/'
export const PROCESSED_PREFIX = 'recipes/'

export const toProcessedKey = (uploadKey: string): string => {
  if (!uploadKey.startsWith(UPLOAD_PREFIX)) {
    throw new Error(`Expected key to start with "${UPLOAD_PREFIX}", got "${uploadKey}"`)
  }
  const afterUpload = uploadKey.slice(UPLOAD_PREFIX.length)
  if (afterUpload.length === 0) {
    throw new Error(`Expected key to have content after "${UPLOAD_PREFIX}", got "${uploadKey}"`)
  }
  const stripped = afterUpload.startsWith(PROCESSED_PREFIX)
    ? afterUpload.slice(PROCESSED_PREFIX.length)
    : afterUpload
  return PROCESSED_PREFIX + stripped
}

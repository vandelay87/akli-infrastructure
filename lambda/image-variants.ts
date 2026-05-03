export const VARIANT_SUFFIXES = ['thumb', 'medium', 'full'] as const

export type VariantSuffix = (typeof VARIANT_SUFFIXES)[number]

export const UPLOAD_PREFIX = 'uploads/recipes/'
export const PROCESSED_PREFIX = 'recipes/'

export const toProcessedKey = (uploadKey: string): string => {
  if (!uploadKey.startsWith(UPLOAD_PREFIX)) {
    throw new Error(`Expected key to start with "${UPLOAD_PREFIX}", got "${uploadKey}"`)
  }
  const suffix = uploadKey.slice(UPLOAD_PREFIX.length)
  if (suffix.length === 0) {
    throw new Error(`Expected key to have content after "${UPLOAD_PREFIX}", got "${uploadKey}"`)
  }
  return PROCESSED_PREFIX + suffix
}

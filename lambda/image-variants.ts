export const VARIANT_SUFFIXES = ['thumb', 'medium', 'full'] as const

export type VariantSuffix = (typeof VARIANT_SUFFIXES)[number]

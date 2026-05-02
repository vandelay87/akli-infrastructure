import { PROCESSED_PREFIX, UPLOAD_PREFIX, toProcessedKey } from '../../lambda/image-variants'

describe('image-variants', () => {
  describe('PROCESSED_PREFIX constant', () => {
    it('is "recipes/"', () => {
      expect(PROCESSED_PREFIX).toBe('recipes/')
    })
  })

  describe('UPLOAD_PREFIX constant', () => {
    it('is "uploads/"', () => {
      expect(UPLOAD_PREFIX).toBe('uploads/')
    })
  })

  describe('toProcessedKey', () => {
    it('maps a cover upload key to its processed key', () => {
      expect(toProcessedKey('uploads/recipes/abc/cover')).toBe('recipes/abc/cover')
    })

    it('maps a step upload key to its processed key', () => {
      expect(toProcessedKey('uploads/recipes/abc/step-2')).toBe('recipes/abc/step-2')
    })

    it('throws when the upload key does not start with "uploads/"', () => {
      expect(() => toProcessedKey('not-uploads/foo')).toThrow(/uploads\//)
    })

    it('throws when the upload key has no suffix after "uploads/"', () => {
      expect(() => toProcessedKey('uploads/')).toThrow()
    })

    it('preserves a stray double-slash after the upload prefix', () => {
      expect(toProcessedKey('uploads//double-slash')).toBe('recipes//double-slash')
    })
  })
})

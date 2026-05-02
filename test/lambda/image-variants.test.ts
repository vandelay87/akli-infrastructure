import { PROCESSED_PREFIX, UPLOAD_PREFIX, toProcessedKey } from '../../lambda/image-variants'

describe('image-variants', () => {
  describe('PROCESSED_PREFIX constant', () => {
    it('is "recipes/" so processed objects sit under the recipes/ namespace 1:1 with the public URL', () => {
      expect(PROCESSED_PREFIX).toBe('recipes/')
    })
  })

  describe('UPLOAD_PREFIX constant', () => {
    it('remains "uploads/" — the resizer S3 trigger still filters on this prefix', () => {
      expect(UPLOAD_PREFIX).toBe('uploads/')
    })
  })

  describe('toProcessedKey', () => {
    it('maps a cover upload key to the recipes/<id>/cover processed key (no double "recipes/")', () => {
      expect(toProcessedKey('uploads/recipes/abc/cover')).toBe('recipes/abc/cover')
    })

    it('maps a step upload key to the recipes/<id>/step-<n> processed key', () => {
      expect(toProcessedKey('uploads/recipes/abc/step-2')).toBe('recipes/abc/step-2')
    })

    it('throws when the upload key does not start with "uploads/"', () => {
      expect(() => toProcessedKey('not-uploads/foo')).toThrow(/uploads\//)
    })

    it('throws when the upload key is exactly "uploads/" with no suffix', () => {
      expect(() => toProcessedKey('uploads/')).toThrow()
    })

    it('preserves a stray double-slash after the upload prefix (returns "recipes//double-slash")', () => {
      expect(toProcessedKey('uploads//double-slash')).toBe('recipes//double-slash')
    })
  })
})

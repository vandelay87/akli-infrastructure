import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { CertificateStack } from '../lib/certificate-stack'

function createStack(): CertificateStack {
  const app = new cdk.App()

  return new CertificateStack(app, 'TestCertificateStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
  })
}

function createTestStack(): Template {
  return Template.fromStack(createStack())
}

describe('CertificateStack', () => {
  let template: Template

  beforeAll(() => {
    template = createTestStack()
  })

  describe('Site certificate', () => {
    it('creates a certificate for akli.dev', () => {
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: 'akli.dev',
        SubjectAlternativeNames: Match.arrayWith(['www.akli.dev']),
      })
    })

    it('does not change the SiteCert domain or subject alternative names (regression guard)', () => {
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: 'akli.dev',
        SubjectAlternativeNames: ['www.akli.dev'],
      })
    })
  })

  describe('API certificate', () => {
    it('creates a separate certificate for api.akli.dev', () => {
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: 'api.akli.dev',
      })
    })
  })

  describe('Images certificate', () => {
    it('creates a dedicated certificate for images.akli.dev with DNS validation', () => {
      template.hasResourceProperties(
        'AWS::CertificateManager::Certificate',
        Match.objectLike({
          DomainName: 'images.akli.dev',
          ValidationMethod: 'DNS',
        }),
      )
    })

    it('exports an ImagesCertArn CloudFormation output referencing the new certificate', () => {
      template.hasOutput(
        'ImagesCertArn',
        Match.objectLike({
          Value: Match.objectLike({ Ref: Match.stringLikeRegexp('^ImagesCert') }),
        }),
      )
    })
  })

  describe('Certificate count', () => {
    it('synthesises exactly three ACM certificates (Site, Api, Images)', () => {
      template.resourceCountIs('AWS::CertificateManager::Certificate', 3)
    })
  })

  describe('Cross-region references', () => {
    it('enables crossRegionReferences on the stack instance', () => {
      const stack = createStack()
      // CDK exposes the resolved value as `_crossRegionReferences` on the Stack instance
      // (the public `crossRegionReferences` is on StackProps, the input).
      expect(stack._crossRegionReferences).toBe(true)
    })
  })

  describe('Route 53 Hosted Zone', () => {
    it('creates a hosted zone for akli.dev', () => {
      template.hasResourceProperties('AWS::Route53::HostedZone', {
        Name: 'akli.dev.',
      })
    })
  })
})

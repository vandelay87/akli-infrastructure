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

describe('CertificateStack', () => {
  let stack: CertificateStack
  let template: Template

  beforeAll(() => {
    stack = createStack()
    template = Template.fromStack(stack)
  })

  describe('Site certificate', () => {
    it('creates a certificate for akli.dev with exactly www.akli.dev as SAN', () => {
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
  })

  describe('Certificate count', () => {
    it('synthesises exactly three ACM certificates (Site, Api, Images)', () => {
      template.resourceCountIs('AWS::CertificateManager::Certificate', 3)
    })
  })

  describe('Cross-region references', () => {
    it('enables crossRegionReferences on the stack instance', () => {
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

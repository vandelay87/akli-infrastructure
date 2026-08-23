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

  describe('Subdomain certificates', () => {
    it.each([
      ['api.akli.dev'],
      ['images.akli.dev'],
      ['pokedex.akli.dev'],
      ['sandbox.akli.dev'],
    ])('creates a dedicated certificate for %s with DNS validation', (domainName) => {
      template.hasResourceProperties(
        'AWS::CertificateManager::Certificate',
        Match.objectLike({
          DomainName: domainName,
          ValidationMethod: 'DNS',
        }),
      )
    })
  })

  describe('Certificate count', () => {
    it('synthesises exactly six ACM certificates (Site, Api, Images, Pokedex, Sandbox, Storybook)', () => {
      template.resourceCountIs('AWS::CertificateManager::Certificate', 6)
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

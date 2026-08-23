import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { CertificateStack } from '../lib/certificate-stack'

const SITE_DOMAIN = 'akli.dev'
const SUBDOMAIN_CERT_DOMAINS = [
  'api.akli.dev',
  'images.akli.dev',
  'pokedex.akli.dev',
  'sandbox.akli.dev',
  'storybook.akli.dev',
]
const ALL_CERT_DOMAINS = [SITE_DOMAIN, ...SUBDOMAIN_CERT_DOMAINS]

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
    it.each(SUBDOMAIN_CERT_DOMAINS.map((domain) => [domain]))('creates a dedicated certificate for %s with DNS validation', (domainName) => {
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
    it(`synthesises exactly ${ALL_CERT_DOMAINS.length} ACM certificates (Site, Api, Images, Pokedex, Sandbox, Storybook)`, () => {
      template.resourceCountIs('AWS::CertificateManager::Certificate', ALL_CERT_DOMAINS.length)
    })
  })

  describe('Certificate distinctness', () => {
    it('every certificate (including StorybookCert) has a distinct domain name — no cert is accidentally reused across subdomains', () => {
      // Catches a copy-paste bug where a new subdomain cert (e.g. StorybookCert)
      // is created but its DomainName is accidentally left pointing at another
      // app's domain — resourceCountIs alone wouldn't catch that, since the
      // count would still be correct. Derived from ALL_CERT_DOMAINS so a future
      // subdomain needs no edit here.
      const certs = template.findResources('AWS::CertificateManager::Certificate')
      const domainNames = Object.values(certs).map(
        (c) => (c as { Properties: { DomainName: string } }).Properties.DomainName,
      )

      expect(new Set(domainNames).size).toBe(domainNames.length)
      expect(domainNames).toEqual(expect.arrayContaining(ALL_CERT_DOMAINS))
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

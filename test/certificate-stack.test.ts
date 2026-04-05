import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { CertificateStack } from '../lib/certificate-stack'

function createTestStack(): Template {
  const app = new cdk.App()

  const stack = new CertificateStack(app, 'TestCertificateStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  return Template.fromStack(stack)
}

describe('CertificateStack', () => {
  let template: Template

  beforeAll(() => {
    template = createTestStack()
  })

  describe('ACM Certificate', () => {
    it('creates a certificate for akli.dev', () => {
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        DomainName: 'akli.dev',
      })
    })

    it('includes www.akli.dev as a subject alternative name', () => {
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        SubjectAlternativeNames: Match.arrayWith(['www.akli.dev']),
      })
    })

    it('includes api.akli.dev as a subject alternative name', () => {
      template.hasResourceProperties('AWS::CertificateManager::Certificate', {
        SubjectAlternativeNames: Match.arrayWith(['api.akli.dev']),
      })
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

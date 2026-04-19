import type { StackProps } from 'aws-cdk-lib';
import { Stack } from 'aws-cdk-lib'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import type { Construct } from 'constructs'

const DOMAIN_NAME = 'akli.dev'
const WWW_DOMAIN_NAME = `www.${DOMAIN_NAME}`
const API_DOMAIN_NAME = `api.${DOMAIN_NAME}`

/**
 * Separate stack for ACM certificates and Route 53 hosted zone.
 * Must be deployed to us-east-1 because CloudFront only accepts certificates
 * from that region.
 */
export class CertificateStack extends Stack {
  public readonly hostedZone: route53.HostedZone
  public readonly certificate: certificatemanager.Certificate
  public readonly apiCertificate: certificatemanager.Certificate

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    this.hostedZone = new route53.HostedZone(this, 'HostedZone', {
      zoneName: DOMAIN_NAME,
    })

    // Site certificate for akli.dev and www.akli.dev — used by AkliInfrastructureStack
    this.certificate = new certificatemanager.Certificate(this, 'SiteCert', {
      domainName: DOMAIN_NAME,
      subjectAlternativeNames: [WWW_DOMAIN_NAME],
      validation: certificatemanager.CertificateValidation.fromDns(this.hostedZone),
    })

    // Separate certificate for api.akli.dev — avoids replacing the site cert which would break cross-stack exports
    this.apiCertificate = new certificatemanager.Certificate(this, 'ApiCert', {
      domainName: API_DOMAIN_NAME,
      validation: certificatemanager.CertificateValidation.fromDns(this.hostedZone),
    })
  }
}

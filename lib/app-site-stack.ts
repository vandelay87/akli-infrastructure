import type { StackProps } from 'aws-cdk-lib'
import { Stack } from 'aws-cdk-lib'
import type * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import type * as route53 from 'aws-cdk-lib/aws-route53'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'

export interface AppSiteStackProps extends StackProps {
  /** e.g. 'Pokedex' | 'Sandbox' — used to build descriptive construct IDs */
  appName: string
  /** e.g. 'pokedex.akli.dev' | 'sandbox.akli.dev' */
  domainName: string
  /** Route53 recordName (subdomain label), e.g. 'pokedex' | 'sandbox' */
  recordName: string
  hostedZone: route53.IHostedZone
  certificate: certificatemanager.ICertificate
  /** Cross-stack bucket reference (PokedexBucket/SandboxBucket) */
  bucket: s3.IBucket
}

/**
 * Stub — resource creation not yet implemented. This exists solely so
 * test/app-site-stack.test.ts can import and construct AppSiteStack without
 * a compile error. See issue #214 for the real implementation.
 */
export class AppSiteStack extends Stack {
  constructor(scope: Construct, id: string, props: AppSiteStackProps) {
    super(scope, id, props)

    // Intentionally not implemented yet — cdk-engineer builds the
    // CloudFront distribution, OAC, bucket-policy re-attachment, and
    // Route53 records here. Referencing props keeps the constructor
    // shape honest without creating any resources.
    void props
  }
}

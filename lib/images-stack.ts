import type { StackProps } from 'aws-cdk-lib'
import { Stack } from 'aws-cdk-lib'
import type * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import type * as route53 from 'aws-cdk-lib/aws-route53'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'

interface ImagesStackProps extends StackProps {
  hostedZone: route53.IHostedZone
  imagesCertificate: certificatemanager.ICertificate
  recipeImageBucket: s3.IBucket
}

/**
 * CloudFront distribution for images.akli.dev.
 *
 * Phase 1: serves the recipe-images S3 bucket via OAC under `recipes/*`.
 * Default behaviour returns a synthetic 404 via a viewer-request CloudFront
 * Function so non-routed paths never hit the origin.
 *
 * Stub — implementation to follow in cdk-engineer pass.
 */
export class ImagesStack extends Stack {
  constructor(scope: Construct, id: string, props: ImagesStackProps) {
    super(scope, id, props)
    // not implemented — cdk-engineer fills this in
  }
}

import { RemovalPolicy } from 'aws-cdk-lib'
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as s3 from 'aws-cdk-lib/aws-s3'
import type { Construct } from 'constructs'

export function createHardenedAppBucket(scope: Construct, id: string): s3.Bucket {
  return new s3.Bucket(scope, id, {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
  })
}

export function grantCloudFrontRead(
  bucket: s3.Bucket,
  distribution: cloudfront.Distribution,
  account: string,
): void {
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'AllowCloudFrontServicePrincipal',
    effect: iam.Effect.ALLOW,
    principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
    actions: ['s3:GetObject', 's3:ListBucket'],
    resources: [
      bucket.bucketArn,
      `${bucket.bucketArn}/*`,
    ],
    conditions: {
      StringEquals: {
        'AWS:SourceArn': `arn:aws:cloudfront::${account}:distribution/${distribution.distributionId}`,
      },
    },
  }))
}

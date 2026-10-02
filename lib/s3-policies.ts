import { RemovalPolicy, Stack } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
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

/**
 * Cross-stack OAC origin. The bucket is re-imported via `fromBucketAttributes`
 * so `S3BucketOrigin.withOriginAccessControl` skips its auto-attached policy,
 * whose exact-distribution `aws:SourceArn` would create a stack cycle. The
 * grant is instead added on the original `bucket` handle (imported handles
 * silently no-op on `addToResourcePolicy`, so `bucket` must be the owned
 * bucket), with an account-scoped wildcard SourceArn. `StringLike` is required
 * for the `*` to match.
 *
 * `oacId` and `importedBucketId` are separate because callers don't always
 * share a prefix (ImagesStack uses `ImagesOAC` / `ImportedRecipeImageBucket`).
 */
export function createCrossStackOacOrigin(
  scope: Construct,
  oacId: string,
  importedBucketId: string,
  bucket: s3.IBucket,
): cloudfront.IOrigin {
  const originAccessControl = new cloudfront.S3OriginAccessControl(scope, oacId)

  const importedBucket = s3.Bucket.fromBucketAttributes(scope, importedBucketId, {
    bucketArn: bucket.bucketArn,
    region: bucket.env.region,
  })

  bucket.addToResourcePolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
    actions: ['s3:GetObject'],
    resources: [`${bucket.bucketArn}/*`],
    conditions: {
      StringLike: {
        'aws:SourceArn': `arn:aws:cloudfront::${Stack.of(scope).account}:distribution/*`,
      },
    },
  }))

  return origins.S3BucketOrigin.withOriginAccessControl(importedBucket, { originAccessControl })
}

import { RemovalPolicy } from 'aws-cdk-lib'
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
 * Cross-stack OAC origin: re-imports the bucket via `fromBucketAttributes` so
 * `S3BucketOrigin.withOriginAccessControl` treats it as imported and skips its
 * auto-attached bucket policy. Auto-attach would scope `aws:SourceArn` to the
 * exact `distribution.distributionId`, which would create a cyclic dependency
 * back from the bucket-owning stack to this distribution (the distribution's
 * stack already depends on the bucket via this origin). The bucket policy is
 * granted separately below (`grantCloudFrontReadCrossStack`), scoped to a
 * wildcard SourceArn, to keep that cycle broken.
 *
 * `oacId` and `importedBucketId` are taken as separate construct IDs (rather
 * than derived from one prefix) because existing callers don't always share
 * a prefix between the two — ImagesStack uses `ImagesOAC` / `ImportedRecipeImageBucket`.
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

  return origins.S3BucketOrigin.withOriginAccessControl(importedBucket, { originAccessControl })
}

/**
 * Grants CloudFront read access for the cross-stack case, where the bucket
 * policy is added from a stack that doesn't own the distribution. Must be
 * called on the original (non-imported) bucket handle — imported handles
 * (`fromBucketAttributes`) silently no-op on `addToResourcePolicy`.
 *
 * Uses a wildcard, account-scoped SourceArn rather than the exact
 * distribution ARN (see `createCrossStackOacOrigin` above for why exact
 * scoping isn't possible here without a stack cycle). The OAC association on
 * the distribution side still gates which CloudFront principals reach the
 * bucket; this wildcard only limits the grant to this account's CloudFront
 * distributions.
 *
 * `StringLike` (not `StringEquals`) is required for the trailing `*` to be
 * treated as a wildcard — CloudFront sends the specific distribution ARN as
 * `aws:SourceArn`, so `StringEquals` would require an exact match against the
 * literal `…/distribution/*` string and the Allow would never fire.
 */
export function grantCloudFrontReadCrossStack(bucket: s3.IBucket, account: string): void {
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
    actions: ['s3:GetObject'],
    resources: [`${bucket.bucketArn}/*`],
    conditions: {
      StringLike: {
        'aws:SourceArn': `arn:aws:cloudfront::${account}:distribution/*`,
      },
    },
  }))
}

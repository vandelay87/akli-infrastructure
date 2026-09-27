import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { grantCloudFrontRead, grantCloudFrontReadCrossStack } from '../lib/s3-policies'
import { bucketPolicyStatements, findResourceEntryByLogicalIdPrefix, statementActions } from './cdk-test-helpers'
import type { CfnPolicyStatement } from './cdk-test-helpers'

const ACCOUNT = '123456789012'

function createStack(): cdk.Stack {
  return new cdk.Stack(new cdk.App(), 'TestStack', { env: { account: ACCOUNT, region: 'eu-west-2' } })
}

describe('grantCloudFrontReadCrossStack', () => {
  let statements: CfnPolicyStatement[]
  let bucketLogicalId: string

  beforeAll(() => {
    const stack = createStack()
    const bucket = new s3.Bucket(stack, 'Bucket')
    grantCloudFrontReadCrossStack(bucket, ACCOUNT)
    const template = Template.fromStack(stack)
    ;[bucketLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::S3::Bucket', 'Bucket')
    statements = bucketPolicyStatements(template, 'Bucket')
  })

  it('adds a single GetObject statement on the bucket objects, scoped to any CloudFront distribution in the account', () => {
    expect(statements).toEqual([{
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject',
      Resource: {
        'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketLogicalId, 'Arn'] }, '/*']],
      },
      Condition: {
        StringLike: { 'aws:SourceArn': `arn:aws:cloudfront::${ACCOUNT}:distribution/*` },
      },
    }])
  })

  it('does not grant s3:ListBucket', () => {
    expect(statements.flatMap(statementActions)).not.toContain('s3:ListBucket')
  })
})

describe('grantCloudFrontRead', () => {
  let template: Template
  let bucketLogicalId: string
  let distributionLogicalId: string

  beforeAll(() => {
    const stack = createStack()
    const bucket = new s3.Bucket(stack, 'Bucket')
    const distribution = new cloudfront.Distribution(stack, 'Distribution', {
      defaultBehavior: { origin: new origins.HttpOrigin('example.com') },
    })
    grantCloudFrontRead(bucket, distribution, ACCOUNT)
    template = Template.fromStack(stack)
    ;[bucketLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::S3::Bucket', 'Bucket')
    ;[distributionLogicalId] = findResourceEntryByLogicalIdPrefix(template, 'AWS::CloudFront::Distribution', 'Distribution')
  })

  it('adds a GetObject + ListBucket statement on the bucket and its objects, scoped to the given distribution', () => {
    expect(bucketPolicyStatements(template, 'Bucket')).toEqual([{
      Sid: 'AllowCloudFrontServicePrincipal',
      Effect: 'Allow',
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: ['s3:GetObject', 's3:ListBucket'],
      Resource: [
        { 'Fn::GetAtt': [bucketLogicalId, 'Arn'] },
        { 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketLogicalId, 'Arn'] }, '/*']] },
      ],
      Condition: {
        StringEquals: {
          'AWS:SourceArn': {
            'Fn::Join': ['', [`arn:aws:cloudfront::${ACCOUNT}:distribution/`, { Ref: distributionLogicalId }]],
          },
        },
      },
    }])
  })
})

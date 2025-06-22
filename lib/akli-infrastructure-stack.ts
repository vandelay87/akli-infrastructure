import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration, SecretValue } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as iam from 'aws-cdk-lib/aws-iam'

export class AkliInfrastructureStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // Disable termination protection
    this.terminationProtection = false

    const DOMAIN_NAME = 'akli.dev'
    const WWW_DOMAIN_NAME = `www.${DOMAIN_NAME}`

    // Add secrets
    new secretsmanager.Secret(this, 'CdkDefaultAccount', {
      secretName: 'CDK_DEFAULT_ACCOUNT',
      secretStringValue: SecretValue.unsafePlainText(process.env.CDK_DEFAULT_ACCOUNT || ''),
    });
    new secretsmanager.Secret(this, 'CdkDefaultRegion', {
      secretName: 'CDK_DEFAULT_REGION',
      secretStringValue: SecretValue.unsafePlainText(process.env.CDK_DEFAULT_REGION || ''),
    });

    // Lookup the Route 53 hosted zone
    const hostedZone = new route53.HostedZone(this, 'HostedZone', {
      zoneName: DOMAIN_NAME,
    })

    // TLS certificate for domain - MUST be in us-east-1 for CloudFront
    const certificate = new certificatemanager.DnsValidatedCertificate(this, 'SiteCert', {
      domainName: DOMAIN_NAME,
      subjectAlternativeNames: [WWW_DOMAIN_NAME],
      hostedZone,
      region: 'us-east-1', // Cross-region certificate
    })

    // S3 bucket for everything
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    })

    // Origin Access Control
    const originAccessControl = new cloudfront.S3OriginAccessControl(this, 'SiteOAC', {
      description: `OAC for ${DOMAIN_NAME}`,
    })

    // Security headers
    const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.seconds(31536000),
          includeSubdomains: true,
          preload: true,
          override: true
        },
      },
    })

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      domainNames: [DOMAIN_NAME, WWW_DOMAIN_NAME], // Add both domains
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket, {
          originAccessControl: originAccessControl,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeadersPolicy,
        compress: true,
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html', // SPA fallback
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html', // SPA fallback
          ttl: Duration.minutes(5),
        },
      ],
    })

    // Grant CloudFront access to S3 bucket
    siteBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudFrontServicePrincipal',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [`${siteBucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        },
      },
    }))

    // DNS A record for apex domain
    new route53.ARecord(this, 'SiteAliasRecord', {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    })

    // DNS A record for www subdomain
    new route53.ARecord(this, 'WWWSiteAliasRecord', {
      zone: hostedZone,
      recordName: 'www',
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    })

    // IAM user for GitHub Actions deployment
    const deployUser = new iam.User(this, 'GitHubActionsUser', {
      userName: 'github-actions-deploy',
    })

    // Access key for GitHub Actions
    const accessKey = new iam.AccessKey(this, 'GitHubActionsAccessKey', {
      user: deployUser,
    })

    // Policy for S3 and CloudFront access
    const deployPolicy = new iam.Policy(this, 'GitHubActionsDeployPolicy', {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            's3:GetObject',
            's3:PutObject',
            's3:DeleteObject',
            's3:ListBucket',
          ],
          resources: [
            siteBucket.bucketArn,
            `${siteBucket.bucketArn}/*`,
          ],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['cloudfront:CreateInvalidation'],
          resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
        }),
      ],
    })

    // Attach policy to user
    deployUser.attachInlinePolicy(deployPolicy)

    // IAM user for CDK GitHub Actions (separate user for infrastructure)
    const cdkUser = new iam.User(this, 'CDKGitHubActionsUser', {
      userName: 'cdk-github-actions',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('PowerUserAccess'), // For CDK operations
      ],
    })

    // Access key for CDK GitHub Actions
    const cdkAccessKey = new iam.AccessKey(this, 'CDKGitHubActionsAccessKey', {
      user: cdkUser,
    })

    // Outputs
    new CfnOutput(this, 'BucketName', {
      value: siteBucket.bucketName,
      description: 'S3 bucket name',
    })

    new CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    })

    new CfnOutput(this, 'WebsiteUrl', {
      value: `https://${DOMAIN_NAME}`,
      description: 'Website URL',
    })

    new CfnOutput(this, 'WWWWebsiteUrl', {
      value: `https://${WWW_DOMAIN_NAME}`,
      description: 'WWW Website URL',
    })

    new CfnOutput(this, 'GitHubActionsAccessKeyId', {
      value: accessKey.accessKeyId,
      description: 'Access Key ID for GitHub Actions',
    })

    new CfnOutput(this, 'GitHubActionsSecretAccessKey', {
      value: accessKey.secretAccessKey.unsafeUnwrap(),
      description: 'Secret Access Key for GitHub Actions (handle securely!)',
    })

    new CfnOutput(this, 'CDKGitHubActionsAccessKeyId', {
      value: cdkAccessKey.accessKeyId,
      description: 'Access Key ID for CDK GitHub Actions',
    })

    new CfnOutput(this, 'CDKGitHubActionsSecretAccessKey', {
      value: cdkAccessKey.secretAccessKey.unsafeUnwrap(),
      description: 'Secret Access Key for CDK GitHub Actions (handle securely!)',
    })
  }
}

import { Stack, StackProps, RemovalPolicy, CfnOutput, Duration, SecretValue } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as iam from 'aws-cdk-lib/aws-iam'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as path from 'path'

interface AkliInfrastructureStackProps extends StackProps {
  hostedZone: route53.IHostedZone
  certificate: certificatemanager.ICertificate
}

export class AkliInfrastructureStack extends Stack {
  constructor(scope: Construct, id: string, props: AkliInfrastructureStackProps) {
    super(scope, id, props)

    const { hostedZone, certificate } = props

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

    // Cache policy for images with query string support
    const imageCachePolicy = new cloudfront.CachePolicy(this, 'ImageCachePolicy', {
      cachePolicyName: 'ImageOptimizationPolicy',
      defaultTtl: Duration.days(30),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(), // Allow all query params
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Accept', 'CloudFront-Viewer-Country'),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    })

    const subdirectoryIndexHandler = new cloudfront.Function(this, 'SubfolderIndexRewrite', {
      code: cloudfront.FunctionCode.fromInline(`
        function handler(event) {
          var request = event.request;
          var uri = request.uri;

          // If it ends in a slash, it's a directory; fetch index.html
          if (uri.endsWith('/')) {
            request.uri += 'index.html';
          }
          // If it DOES NOT have a '.' (e.g., .js, .css, .png)
          // AND does not end in a slash, it's a "naked" path (e.g., /sand-box)
          else if (!uri.includes('.')) {
            request.uri += '/index.html';
          }

          return request;
        }
      `),
    });

    // ~$0.06/100K requests at 256 MB
    const ssrFunction = new NodejsFunction(this, 'SsrFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambda', 'ssr-handler.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      description: 'SSR renderer for akli.dev — placeholder handler until the React server bundle is deployed',
    })

    // Lambda Function URL — AWS_IAM auth, CloudFront signs requests via OAC
    const ssrFunctionUrl = ssrFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    })

    const ssrCachePolicy = new cloudfront.CachePolicy(this, 'SsrCachePolicy', {
      cachePolicyName: 'SsrCachePolicy',
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.seconds(60),
      minTtl: Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    })

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket, {
      originAccessControl: originAccessControl,
    })

    // CloudFront OAC for Lambda — signs requests so AWS_IAM auth passes
    const functionUrlOrigin = new origins.FunctionUrlOrigin(ssrFunctionUrl)

    const ssrOriginGroup = new origins.OriginGroup({
      primaryOrigin: functionUrlOrigin,
      fallbackOrigin: s3Origin,
      fallbackStatusCodes: [500, 502, 503, 504],
    })

    const staticAssetBehavior: cloudfront.BehaviorOptions = {
      origin: s3Origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: securityHeadersPolicy,
      compress: true,
    }

    const staticFileExtensions = [
      '*.js', '*.css', '*.ico', '*.svg', '*.webp',
      '*.woff2', '*.png', '*.jpg', '*.json', '*.xml', '*.txt', '*.pdf',
    ]

    const staticAssetBehaviors: Record<string, cloudfront.BehaviorOptions> = {}
    for (const pattern of staticFileExtensions) {
      staticAssetBehaviors[pattern] = staticAssetBehavior
    }

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      domainNames: [DOMAIN_NAME, WWW_DOMAIN_NAME],
      certificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: ssrOriginGroup,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: ssrCachePolicy,
        responseHeadersPolicy: securityHeadersPolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },
      additionalBehaviors: {
        ...staticAssetBehaviors,
        'images/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: imageCachePolicy,
          responseHeadersPolicy: securityHeadersPolicy,
          compress: true,
        },
        'apps/sand-box*': {
          ...staticAssetBehavior,
          functionAssociations: [{
            function: subdirectoryIndexHandler,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          }],
        },
        'apps/pokedex*': {
          ...staticAssetBehavior,
          functionAssociations: [{
            function: subdirectoryIndexHandler,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          }],
        },
      },
    })

    // Grant CloudFront access to Lambda Function URL via OAC
    ssrFunction.addPermission('CloudFrontOACInvoke', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunctionUrl',
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
    })

    // Grant CloudFront access to S3 bucket
    siteBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudFrontServicePrincipal',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        siteBucket.bucketArn,
        `${siteBucket.bucketArn}/*`,
      ],
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

    // Access key for GitHub Actions - stored in Secrets Manager
    const accessKey = new iam.AccessKey(this, 'GitHubActionsAccessKey', {
      user: deployUser,
    })

    // Store GitHub Actions credentials in Secrets Manager
    new secretsmanager.Secret(this, 'GitHubActionsCredentials', {
      secretName: 'github-actions-credentials',
      secretObjectValue: {
        accessKeyId: SecretValue.unsafePlainText(accessKey.accessKeyId),
        secretAccessKey: accessKey.secretAccessKey,
      },
      description: 'GitHub Actions deployment credentials',
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
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction'],
          resources: [ssrFunction.functionArn],
        }),
      ],
    })

    // Attach policy to user
    deployUser.attachInlinePolicy(deployPolicy)

    // IAM user for CDK GitHub Actions (separate user for infrastructure)
    const cdkUser = new iam.User(this, 'CDKGitHubActionsUser', {
      userName: 'cdk-github-actions',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess'), // CDK bootstrap requires IAM permissions
      ],
    })

    // Access key for CDK GitHub Actions - stored in Secrets Manager
    const cdkAccessKey = new iam.AccessKey(this, 'CDKGitHubActionsAccessKey', {
      user: cdkUser,
    })

    // Store CDK GitHub Actions credentials in Secrets Manager
    new secretsmanager.Secret(this, 'CDKGitHubActionsCredentials', {
      secretName: 'cdk-github-actions-credentials',
      secretObjectValue: {
        accessKeyId: SecretValue.unsafePlainText(cdkAccessKey.accessKeyId),
        secretAccessKey: cdkAccessKey.secretAccessKey,
      },
      description: 'CDK GitHub Actions credentials',
    })

    // CloudFormation outputs
    new CfnOutput(this, 'FunctionUrl', {
      value: ssrFunctionUrl.url,
      description: 'Lambda Function URL for SSR streaming',
    })

    new CfnOutput(this, 'SsrFunctionName', {
      value: ssrFunction.functionName,
      description: 'SSR Lambda function name',
    })

    new CfnOutput(this, 'SsrFunctionArn', {
      value: ssrFunction.functionArn,
      description: 'SSR Lambda function ARN',
    })

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

    new CfnOutput(this, 'GitHubActionsSecretsManagerName', {
      value: 'github-actions-credentials',
      description: 'Secrets Manager secret name for GitHub Actions credentials',
    })

    new CfnOutput(this, 'CDKGitHubActionsSecretsManagerName', {
      value: 'cdk-github-actions-credentials',
      description: 'Secrets Manager secret name for CDK GitHub Actions credentials',
    })
  }
}

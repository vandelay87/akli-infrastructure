import * as path from 'path'
import type { StackProps} from 'aws-cdk-lib';
import { Stack, RemovalPolicy, CfnOutput, Duration, SecretValue, Fn } from 'aws-cdk-lib'
import type * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'
import { createCachePolicy, createImageCachePolicy, createSecurityHeadersPolicy } from './cdn-policies'

interface AkliInfrastructureStackProps extends StackProps {
  hostedZone: route53.IHostedZone
  certificate: certificatemanager.ICertificate
}

export class AkliInfrastructureStack extends Stack {
  constructor(scope: Construct, id: string, props: AkliInfrastructureStackProps) {
    super(scope, id, props)

    const { hostedZone, certificate } = props

    this.terminationProtection = false

    const DOMAIN_NAME = 'akli.dev'
    const WWW_DOMAIN_NAME = `www.${DOMAIN_NAME}`

    new secretsmanager.Secret(this, 'CdkDefaultAccount', {
      secretName: 'CDK_DEFAULT_ACCOUNT',
      secretStringValue: SecretValue.unsafePlainText(process.env.CDK_DEFAULT_ACCOUNT || ''),
    });
    new secretsmanager.Secret(this, 'CdkDefaultRegion', {
      secretName: 'CDK_DEFAULT_REGION',
      secretStringValue: SecretValue.unsafePlainText(process.env.CDK_DEFAULT_REGION || ''),
    });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    })

    const originAccessControl = new cloudfront.S3OriginAccessControl(this, 'SiteOAC', {
      description: `OAC for ${DOMAIN_NAME}`,
    })

    const pokedexBucket = new s3.Bucket(this, 'PokedexBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    })

    const sandboxBucket = new s3.Bucket(this, 'SandboxBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    })

    const securityHeadersPolicy = createSecurityHeadersPolicy(this)

    const imageCachePolicy = createImageCachePolicy(this)

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

    const ssrCachePolicy = createCachePolicy(this, 'SsrCachePolicy', {
      cachePolicyName: 'SsrCachePolicy',
      defaultTtl: Duration.seconds(60),
    })

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket, {
      originAccessControl: originAccessControl,
    })

    // OAC for Lambda — CloudFront signs requests so AWS_IAM auth passes
    const lambdaOac = new cloudfront.CfnOriginAccessControl(this, 'LambdaOAC', {
      originAccessControlConfig: {
        name: 'LambdaFunctionUrlOAC',
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    })

    // Use HttpOrigin for the Function URL domain — OAC is attached via L1 override below
    const functionUrlOrigin = new origins.HttpOrigin(
      Fn.select(2, Fn.split('/', ssrFunctionUrl.url)),
    )

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
        },
        ...Object.fromEntries(
          ['apps/sand-box*', 'apps/pokedex*'].map((pattern) => [pattern, {
            ...staticAssetBehavior,
            functionAssociations: [{
              function: subdirectoryIndexHandler,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            }],
          }]),
        ),
      },
    })

    // Attach Lambda OAC to the Function URL origin via L1 escape hatch.
    // FunctionUrlOrigin + OriginGroup doesn't propagate OAC to CloudFormation.
    // Origin index 0 is the Lambda Function URL (primary in the OriginGroup).
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution
    cfnDistribution.addPropertyOverride(
      'DistributionConfig.Origins.0.OriginAccessControlId',
      lambdaOac.attrId,
    )

    // Grant CloudFront access to Lambda Function URL via OAC
    ssrFunction.addPermission('CloudFrontOACInvokeFunctionUrl', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunctionUrl',
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
    })
    ssrFunction.addPermission('CloudFrontOACInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
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

    // Grant CloudFront access to Pokedex S3 bucket
    pokedexBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudFrontServicePrincipal',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        pokedexBucket.bucketArn,
        `${pokedexBucket.bucketArn}/*`,
      ],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        },
      },
    }))

    // Grant CloudFront access to Sandbox S3 bucket
    sandboxBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudFrontServicePrincipal',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        sandboxBucket.bucketArn,
        `${sandboxBucket.bucketArn}/*`,
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

    // GitHub OIDC provider — one per account, reused by every per-app deploy Role below.
    // Uses the native AWS::IAM::OIDCProvider resource (iam.OidcProviderNative) rather than the
    // legacy iam.OpenIdConnectProvider, which CDK's own docs mark backward-compatibility-only and
    // which is backed by a Lambda custom resource holding a broad Resource: "*" IAM grant.
    //
    // Two intermediate CA thumbprints, both required — GitHub's OIDC token endpoint can present
    // either one depending on which issued the current leaf cert, and AWS validates against
    // whichever is configured. Confirmed current per GitHub's own OIDC changelog post:
    // https://github.blog/changelog/2023-06-27-github-actions-update-on-oidc-integration-with-aws/
    // ("either can be returned by our servers, requiring customers to trust both").
    const githubOidcProvider = new iam.OidcProviderNative(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      thumbprints: [
        '6938fd4d98bab03faadb97b34396831e3780aea1',
        '1c58a3a8518e8759bf075b76b750d4f2df264fcd',
      ],
    })

    const githubDeployPrincipal = (repo: string): iam.OpenIdConnectPrincipal =>
      new iam.OpenIdConnectPrincipal(githubOidcProvider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:vandelay87/${repo}:ref:refs/heads/main`,
        },
      })

    const s3AppAccessStatement = (bucket: s3.IBucket): iam.PolicyStatement =>
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      })

    const cloudfrontInvalidationStatement = (): iam.PolicyStatement =>
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudfront:CreateInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
      })

    // Per-app GitHub Actions deploy Roles — OIDC-federated, replacing the legacy shared
    // github-actions-deploy IAM User below (removed once all apps have migrated, see #194).
    const personalWebsiteDeployRole = new iam.Role(this, 'PersonalWebsiteDeployRole', {
      roleName: 'personal-website-deploy',
      assumedBy: githubDeployPrincipal('personal-website'),
      description: 'GitHub Actions OIDC deploy role for personal-website',
    })
    personalWebsiteDeployRole.addToPolicy(s3AppAccessStatement(siteBucket))
    personalWebsiteDeployRole.addToPolicy(cloudfrontInvalidationStatement())
    personalWebsiteDeployRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction'],
      resources: [ssrFunction.functionArn],
    }))

    const pokedexDeployRole = new iam.Role(this, 'PokedexDeployRole', {
      roleName: 'pokedex-deploy',
      assumedBy: githubDeployPrincipal('pokedex'),
      description: 'GitHub Actions OIDC deploy role for pokedex',
    })
    pokedexDeployRole.addToPolicy(s3AppAccessStatement(pokedexBucket))
    pokedexDeployRole.addToPolicy(cloudfrontInvalidationStatement())

    const sandboxDeployRole = new iam.Role(this, 'SandboxDeployRole', {
      roleName: 'sandbox-deploy',
      assumedBy: githubDeployPrincipal('sand-box'),
      description: 'GitHub Actions OIDC deploy role for sand-box',
    })
    sandboxDeployRole.addToPolicy(s3AppAccessStatement(sandboxBucket))
    sandboxDeployRole.addToPolicy(cloudfrontInvalidationStatement())

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

    new CfnOutput(this, 'PersonalWebsiteDeployRoleArn', {
      value: personalWebsiteDeployRole.roleArn,
      description: 'IAM Role ARN for personal-website GitHub Actions OIDC deploys',
    })

    new CfnOutput(this, 'PokedexDeployRoleArn', {
      value: pokedexDeployRole.roleArn,
      description: 'IAM Role ARN for pokedex GitHub Actions OIDC deploys',
    })

    new CfnOutput(this, 'SandboxDeployRoleArn', {
      value: sandboxDeployRole.roleArn,
      description: 'IAM Role ARN for sand-box GitHub Actions OIDC deploys',
    })
  }
}

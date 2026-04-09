import { CfnOutput, Duration, Fn, Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import { applyStackTags } from './utils'

const API_DOMAIN_NAME = 'api.akli.dev'

interface ApiStackProps extends StackProps {
  hostedZone: route53.IHostedZone
  apiCertificate: certificatemanager.ICertificate
  pokedexApiUrl: string
  authApiUrl: string
}

/**
 * Shared API stack for api.akli.dev.
 * Creates a CloudFront distribution that routes to individual API origins
 * via cache behaviours. Future APIs add their own behaviour here.
 */
export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props)

    const { hostedZone, apiCertificate, pokedexApiUrl, authApiUrl } = props

    // Extract the domain from the API Gateway URL (strip "https://")
    const pokedexApiDomain = Fn.select(2, Fn.split('/', pokedexApiUrl))

    const pokedexOrigin = new origins.HttpOrigin(pokedexApiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    })

    // Auth API origin
    const authApiDomain = Fn.select(2, Fn.split('/', authApiUrl))

    const authOrigin = new origins.HttpOrigin(authApiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    })

    // Cache policy: 5-minute TTL, forward all query strings
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      cachePolicyName: 'ApiCachePolicy',
      defaultTtl: Duration.minutes(5),
      maxTtl: Duration.minutes(5),
      minTtl: Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    })

    // Origin request policy to forward Host header to API Gateway
    const apiOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'ApiOriginRequestPolicy', {
      originRequestPolicyName: 'ApiOriginRequestPolicy',
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.none(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    })

    // CloudFront distribution for api.akli.dev
    const distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
      domainNames: [API_DOMAIN_NAME],
      certificate: apiCertificate,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        // Default behaviour returns 403 — no default API endpoint
        origin: pokedexOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        '/pokedex/*': {
          origin: pokedexOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: apiCachePolicy,
          originRequestPolicy: apiOriginRequestPolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
        },
        '/auth/*': {
          origin: authOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // AllViewerExceptHostHeader forwards all viewer headers (including Authorization) except Host
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          compress: true,
        },
      },
    })

    // Route 53 A record: api.akli.dev → CloudFront distribution
    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: hostedZone,
      recordName: 'api',
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    })

    new CfnOutput(this, 'ApiDistributionId', {
      value: distribution.distributionId,
      description: 'API CloudFront distribution ID',
    })

    new CfnOutput(this, 'ApiUrl', {
      value: `https://${API_DOMAIN_NAME}`,
      description: 'API URL',
    })

    applyStackTags(this, props)
  }
}

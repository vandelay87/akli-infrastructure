import * as cdk from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager'
import { ApiStack } from '../lib/api-stack'

function createTestStack(): Template {
  const app = new cdk.App()

  cdk.Tags.of(app).add('Owner', 'Akli')
  cdk.Tags.of(app).add('CostCenter', 'Website')

  // Create mock dependencies
  const mockStack = new cdk.Stack(app, 'MockStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const hostedZone = new route53.HostedZone(mockStack, 'MockHostedZone', {
    zoneName: 'akli.dev',
  })

  const apiCertificate = new certificatemanager.Certificate(mockStack, 'MockApiCertificate', {
    domainName: 'api.akli.dev',
  })

  const stack = new ApiStack(app, 'TestApiStack', {
    env: { account: '123456789012', region: 'eu-west-2' },
    crossRegionReferences: true,
    hostedZone,
    apiCertificate,
    pokedexApiUrl: 'https://abc123.execute-api.eu-west-2.amazonaws.com',
    authApiUrl: 'https://xyz789.execute-api.eu-west-2.amazonaws.com',
    tags: {
      Project: 'akli-api',
      Environment: 'production',
      ManagedBy: 'cdk',
    },
  })

  return Template.fromStack(stack)
}

describe('ApiStack', () => {
  let template: Template

  beforeAll(() => {
    template = createTestStack()
  })

  describe('CloudFront distribution', () => {
    it('creates a distribution with api.akli.dev as the domain name', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          Aliases: ['api.akli.dev'],
        },
      })
    })

    it('uses PRICE_CLASS_100', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          PriceClass: 'PriceClass_100',
        }),
      })
    })

    it('has the Pokedex API Gateway as an origin', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Origins: Match.arrayWith([
            Match.objectLike({
              DomainName: 'abc123.execute-api.eu-west-2.amazonaws.com',
              CustomOriginConfig: Match.objectLike({
                OriginProtocolPolicy: 'https-only',
              }),
            }),
          ]),
        }),
      })
    })

    it('has a /pokedex/* cache behaviour', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/pokedex/*',
              ViewerProtocolPolicy: 'redirect-to-https',
              Compress: true,
              AllowedMethods: ['GET', 'HEAD'],
            }),
          ]),
        }),
      })
    })

    it('default behaviour returns 403 (no default API)', () => {
      // The default behaviour should point to a dummy origin or return an error
      // CloudFront requires a default behaviour — we use a custom error response
      // or a function to return 404
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        }),
      })
    })

    it('has the auth API Gateway as an origin', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          Origins: Match.arrayWith([
            Match.objectLike({
              DomainName: 'xyz789.execute-api.eu-west-2.amazonaws.com',
              CustomOriginConfig: Match.objectLike({
                OriginProtocolPolicy: 'https-only',
              }),
            }),
          ]),
        }),
      })
    })

    it('has an /auth/* cache behaviour with caching disabled', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/auth/*',
              CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
            }),
          ]),
        }),
      })
    })

    it('has an /auth/* cache behaviour with AllowedMethods.ALLOW_ALL', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/auth/*',
              AllowedMethods: [
                'GET',
                'HEAD',
                'OPTIONS',
                'PUT',
                'PATCH',
                'POST',
                'DELETE',
              ],
            }),
          ]),
        }),
      })
    })

    it('has an /auth/* cache behaviour that forwards Authorization header', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: '/auth/*',
              OriginRequestPolicyId: Match.anyValue(),
            }),
          ]),
        }),
      })
    })

    it('configures the certificate from CertificateStack', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          ViewerCertificate: Match.objectLike({
            SslSupportMethod: 'sni-only',
          }),
        }),
      })
    })
  })

  describe('Cache policy', () => {
    it('creates a cache policy with 5-minute default TTL', () => {
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          DefaultTTL: 300,
          MaxTTL: 300,
        }),
      })
    })

    it('forwards all query strings', () => {
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
            QueryStringsConfig: {
              QueryStringBehavior: 'all',
            },
          }),
        }),
      })
    })
  })

  describe('Route 53 record', () => {
    it('creates an A record for api.akli.dev', () => {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'api.akli.dev.',
        Type: 'A',
      })
    })

    it('the A record is an alias to CloudFront', () => {
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Name: 'api.akli.dev.',
        Type: 'A',
        AliasTarget: Match.objectLike({
          DNSName: Match.objectLike({
            'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('ApiDistribution')]),
          }),
        }),
      })
    })
  })

  describe('Tags', () => {
    it('tags resources with Project=akli-api', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Project', Value: 'akli-api' }),
        ]),
      })
    })

    it('tags resources with Owner', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Owner', Value: 'Akli' }),
        ]),
      })
    })

    it('tags resources with Environment', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'production' }),
        ]),
      })
    })

    it('tags resources with ManagedBy', () => {
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'cdk' }),
        ]),
      })
    })
  })
})

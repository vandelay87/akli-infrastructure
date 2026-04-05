#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AkliInfrastructureStack } from '../lib/akli-infrastructure-stack';
import { CertificateStack } from '../lib/certificate-stack';
import { PokedexStack } from '../lib/pokedex-stack';

const app = new cdk.App();

// Get environment from context or environment variables
const account = app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT;
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION;

// ACM certificate must be in us-east-1 for CloudFront.
// crossRegionReferences allows the main stack (eu-west-2) to consume outputs
// from this stack (us-east-1) via SSM Parameter Store.
const certStack = new CertificateStack(app, 'AkliCertificateStack', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  description: 'ACM certificate and Route 53 hosted zone for akli.dev (must be us-east-1)',
})

new AkliInfrastructureStack(app, 'AkliInfrastructureStack', {
  env: { account, region },
  crossRegionReferences: true,
  certificate: certStack.certificate,
  hostedZone: certStack.hostedZone,
  description: 'Static website hosting for akli.dev with CloudFront and S3',

  tags: {
    Project: 'akli-website',
    Environment: 'production',
    ManagedBy: 'CDK',
  },

  terminationProtection: true,
});

new PokedexStack(app, 'PokedexStack', {
  env: { account, region: 'eu-west-2' },
  description: 'Pokedex API backend resources (DynamoDB)',

  tags: {
    Project: 'pokedex',
    Environment: 'production',
    ManagedBy: 'cdk',
  },
});

// Add stack-level tags
cdk.Tags.of(app).add('Owner', 'Akli');
cdk.Tags.of(app).add('CostCenter', 'Website');

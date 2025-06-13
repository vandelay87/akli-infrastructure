#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AkliInfrastructureStack } from '../lib/akli-infrastructure-stack';

const app = new cdk.App();

// Get environment from context or environment variables
const account = app.node.tryGetContext('account') || process.env.CDK_DEFAULT_ACCOUNT;
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION;

// Create the stack with proper environment configuration
new AkliInfrastructureStack(app, 'AkliInfrastructureStack', {
  env: {
    account,
    region
  },
  description: 'Static website hosting for akli.dev with CloudFront and S3',

  // Add tags for better resource management
  tags: {
    Project: 'akli-website',
    Environment: 'production',
    ManagedBy: 'CDK',
  },

  // Enable termination protection for production
  terminationProtection: true,
});

// Add stack-level tags
cdk.Tags.of(app).add('Owner', 'Akli');
cdk.Tags.of(app).add('CostCenter', 'Website');

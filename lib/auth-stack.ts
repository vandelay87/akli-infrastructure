import { Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2'

export class AuthStack extends Stack {
  public readonly httpApi!: HttpApi

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    // TODO: implement AuthStack resources
  }
}

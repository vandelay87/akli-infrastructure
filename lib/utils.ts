import type { StackProps } from 'aws-cdk-lib';
import { Tags } from 'aws-cdk-lib'
import type { Construct } from 'constructs'

export function applyStackTags(scope: Construct, props?: StackProps): void {
  if (props?.tags) {
    for (const [key, value] of Object.entries(props.tags)) {
      Tags.of(scope).add(key, value)
    }
  }
}

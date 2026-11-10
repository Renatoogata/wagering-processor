import { Global, Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      useFactory: () =>
        new SQSClient({
          region: process.env.AWS_REGION ?? 'us-east-1',
          endpoint: process.env.AWS_ENDPOINT_URL,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }),
    },
  ],
  exports: [SQS_CLIENT],
})
export class SqsModule {}

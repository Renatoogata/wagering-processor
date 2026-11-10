#!/bin/bash
# Cria as filas do desafio. Idempotente: create-queue com os mesmos atributos não falha.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"

# 1. DLQ primeiro: a fila principal precisa do ARN dela.
awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --region "$REGION" \
  --queue-url "http://localhost:4566/000000000000/wager-transactions-dlq.fifo" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)

# 2. Fila principal com redrive para a DLQ após N recebimentos sem ack.
awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"false\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"${MAX_RECEIVE_COUNT}\\\"}\"
  }"

# 3. Fila onde o outbox publica os eventos de integração.
awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

echo "SQS queues ready"

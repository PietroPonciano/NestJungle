#!/usr/bin/env bash
# =====================================================================
# Criação IDEMPOTENTE das filas SQS (executado pelo LocalStack no hook
# ready.d). Pode rodar N vezes: create-queue com os mesmos atributos
# devolve a URL existente, e set-queue-attributes reaplica a redrive.
#
# Filas (enunciado §10 + decisão D8):
#   wager-transactions.fifo      entrada; MessageGroupId = walletId
#   wager-transactions-dlq.fifo  DLQ da entrada (retenção 14 dias)
#   wager-events.fifo            eventos de saída da outbox (D8: separada
#                                da entrada para o consumidor não ler os
#                                próprios eventos)
#
# Restrição #3: FIFO/dedup do SQS são otimização. ContentBasedDeduplication
# fica DESLIGADO: o produtor informa MessageDeduplicationId explicitamente,
# e a garantia final de não duplicar efeito é a inbox + UNIQUEs no banco.
# =====================================================================
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT_SECONDS:-60}"
DLQ_RETENTION_SECONDS=1209600 # 14 dias (máximo do SQS)

create_fifo() {
  local name="$1"; shift
  awslocal sqs create-queue --region "$REGION" --queue-name "$name" \
    --attributes "FifoQueue=true,ContentBasedDeduplication=false$*" \
    --query QueueUrl --output text
}

DLQ_URL=$(create_fifo wager-transactions-dlq.fifo ",MessageRetentionPeriod=${DLQ_RETENTION_SECONDS}")
DLQ_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

MAIN_URL=$(create_fifo wager-transactions.fifo ",VisibilityTimeout=${VISIBILITY_TIMEOUT}")

# Redrive aplicada separadamente (set-queue-attributes) para que reexecuções
# atualizem maxReceiveCount sem recriar a fila.
REDRIVE=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' "$DLQ_ARN" "$MAX_RECEIVE_COUNT")
awslocal sqs set-queue-attributes --region "$REGION" --queue-url "$MAIN_URL" \
  --attributes "{\"RedrivePolicy\":$(printf '%s' "$REDRIVE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"

EVENTS_URL=$(create_fifo wager-events.fifo "")

echo "[init] filas prontas:"
echo "  $MAIN_URL (redrive -> $DLQ_ARN, maxReceiveCount=$MAX_RECEIVE_COUNT)"
echo "  $DLQ_URL"
echo "  $EVENTS_URL"

/**
 * Taxonomia de falhas (seção 7.2).
 *
 * Códigos estáveis e legíveis por máquina. Cada um diz ao provedor o que fazer:
 *  - "desistir": a operação nunca vai ser aceita como está;
 *  - "corrigir": o payload tem um problema que o provedor pode consertar;
 *  - "aguardar": quem resolve é o próprio sistema (ou suporte).
 *
 * Nunca renomeie um código existente: o provedor depende dele. Para mudar, crie um novo.
 */
export enum FailureCode {
  // ---- saldo
  /** BET sem saldo suficiente. Desistir. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** REFUND/ROLLBACK que deixaria o saldo negativo (regra 7.9). Desistir; requer análise operacional. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',

  // ---- referência (REFUND / ROLLBACK)
  /** A referência não chegou dentro do limite de tentativas (7.1). Desistir ou reenviar a referência antes. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência de outro provider, wallet, jogador, moeda ou rodada (regra 7.2). Corrigir. */
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  /** REFUND para algo que não é BET, ou ROLLBACK para algo que não é BET/WIN/REFUND (regra 7.3). Corrigir. */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** A referência existe mas não foi aplicada (REJECTED/FAILED). Desistir. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** A referência já foi revertida por esse tipo de operação (regra 7.4). Desistir. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Valor da reversão diferente do valor da referência (regra 7.5). Corrigir. */
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',

  // ---- wallet
  /** Moeda da operação diferente da moeda da wallet. Corrigir. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** playerId não é o dono da wallet. Corrigir. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',

  // ---- infraestrutura (status FAILED)
  /** Erro permanente de infraestrutura; auditável. Aguardar / acionar suporte. */
  ProcessingFailed = 'PROCESSING_FAILED',
}

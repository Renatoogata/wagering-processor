import type { OutboxMessage } from '../../domain/messaging';

/** Uma mensagem que o broker NÃO aceitou (as outras do lote foram aceitas). */
export interface PublishFailure {
  id: string;
  error: string;
}

/**
 * Porta do broker de eventos. A aplicação não sabe que é SQS.
 *
 * Contrato: devolve a lista de falhas (vazia = tudo aceito). Pode lançar se o broker
 * estiver inteiro fora do ar; nesse caso NENHUMA mensagem conta como publicada.
 * Implementações devem usar o `id` da mensagem (= eventId) como chave de deduplicação
 * quando o broker suportar.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishFailure[]>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/**
 * Erro de domínio: uma regra de negócio foi violada.
 *
 * Todo erro de domínio carrega um `code` estável e legível por máquina.
 * A camada HTTP/SQS traduz o `code` em status/ação (ex.: 422, ack sem retry),
 * e o provedor decide pelo `code`, nunca pela mensagem em texto.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

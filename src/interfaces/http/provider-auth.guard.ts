import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

/**
 * PONTO DE EXTENSÃO DE AUTENTICAÇÃO (seção 2) — hoje é um no-op consciente.
 *
 * Desenho que adotaríamos (detalhado no ARCHITECTURE.md):
 *  - IdP externo (Keycloak/Zitadel) emite tokens client_credentials, um client por provedor;
 *  - este guard valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`);
 *  - o claim do provedor (ex.: `provider_id`) precisa ser IGUAL ao `providerId` do corpo:
 *    um provedor não pode lançar operações em nome de outro.
 *
 * Os health checks não usam este guard; mensagens da SQS são canal interno confiável,
 * mas o `providerId` delas passa pelas mesmas validações de domínio.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

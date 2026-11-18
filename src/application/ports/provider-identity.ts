/**
 * ProviderIdentityPort — ponto de extensão de autenticação/autorização
 * (enunciado §2; decisão: não implementar autenticação).
 *
 * Desenho alvo (ARCHITECTURE.md): um IdP externo (Keycloak/Zitadel) emite
 * JWT via OIDC (client credentials por provedor); o AuthGuard valida a
 * assinatura e o issuer e extrai o `principal` (client_id). Esta porta então
 * garante que o principal só submete operações do próprio providerId.
 *
 * Hoje a implementação é um stub que permite tudo. A identidade do provedor
 * contida no payload continua sujeita às validações de domínio.
 */
export interface ProviderIdentityPort {
  /** Lança ProviderNotAuthorizedError se `principal` não puder agir como `providerId` (HTTP 403). */
  authorize(principal: string | undefined, providerId: string): Promise<void>;
}

export class AllowAllProviderIdentity implements ProviderIdentityPort {
  authorize(): Promise<void> {
    return Promise.resolve();
  }
}

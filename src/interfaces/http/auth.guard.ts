/**
 * AuthGuard no-op: ponto de extensão explícito (enunciado §2). A decisão de
 * NÃO implementar autenticação está registrada no ARCHITECTURE.md.
 *
 * Desenho alvo: validar `Authorization: Bearer <JWT>` emitido por um IdP
 * externo (Keycloak/Zitadel, OIDC client credentials por provedor), verificar
 * assinatura (JWKS), issuer, audience e expiração, e anexar o principal à
 * requisição. A autorização por provedor fica na ProviderIdentityPort.
 * Os endpoints de health e /metrics ficam fora do guard.
 */
import { type CanActivate, Injectable } from '@nestjs/common';

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

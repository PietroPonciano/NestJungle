import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Container } from './container';
import { AuthGuard } from './interfaces/http/auth.guard';
import { HealthController } from './interfaces/http/health.controller';
import { DocsController } from './interfaces/http/openapi/docs.controller';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { TOKENS } from './shared/tokens';

const CONTAINER = Symbol('Container');

/**
 * Ciclo de vida: liga os workers (consumidor SQS, outbox) ao subir, se
 * habilitados, e os para ANTES de o servidor fechar (SIGTERM: conclui a
 * mensagem em andamento). O ORM fecha por último.
 */
@Injectable()
class Lifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  onApplicationBootstrap(): void {
    if (this.container.config.workersEnabled) this.container.workers.start();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.container.logger.info('encerrando: parando consumidor e workers', { signal });
    await this.container.workers.stop();
    this.container.logger.info('workers parados (mensagem em andamento concluída)');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.container.close();
  }
}

/**
 * Módulo raiz. NestJS fica restrito às camadas externas (interfaces e
 * infraestrutura); domínio e aplicação não importam nada do framework.
 * Toda injeção usa @Inject(TOKEN) explícito (o Bun não emite metadata).
 */
@Module({})
export class AppModule {
  static forRoot(container: Container): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, DocsController, WalletsController, WageringController],
      providers: [
        AuthGuard,
        Lifecycle,
        { provide: CONTAINER, useValue: container },
        { provide: TOKENS.Logger, useValue: container.logger },
        { provide: TOKENS.Metrics, useValue: container.metrics },
        { provide: TOKENS.CreateWallet, useValue: container.createWallet },
        { provide: TOKENS.SubmitWager, useValue: container.submitWager },
        { provide: TOKENS.Queries, useValue: container.queries },
        { provide: TOKENS.Reconcile, useValue: container.reconcile },
        { provide: TOKENS.Health, useValue: container.health },
      ],
    };
  }
}

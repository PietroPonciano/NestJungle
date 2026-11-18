import { createApp } from './bootstrap';
import { loadConfig } from './infrastructure/config/app-config';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, container } = await createApp(config);
  await app.listen(config.port);
  container.logger.info('aplicação iniciada', {
    port: config.port,
    workersEnabled: config.workersEnabled,
    pid: process.pid,
  });
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'falha ao iniciar a aplicação', error: String(error) }),
  );
  process.exit(1);
});

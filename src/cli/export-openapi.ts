/**
 * Exporta o contrato OpenAPI para `docs/openapi.json` (leitura offline,
 * importação no Postman/Insomnia, geração de clientes).
 * `bun run openapi:export`. O teste de contrato falha se o arquivo divergir.
 */
import { OPENAPI_DOCUMENT } from '../interfaces/http/openapi/openapi-document';

const target = process.argv[2] ?? 'docs/openapi.json';
await Bun.write(target, `${JSON.stringify(OPENAPI_DOCUMENT, null, 2)}\n`);
console.log(`OpenAPI exportado em ${target}`);

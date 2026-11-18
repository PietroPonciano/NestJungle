/**
 * Swagger UI em /docs e o contrato em /docs/openapi.json (abertos, como
 * health e métricas).
 *
 * Os arquivos estáticos vêm do pacote `swagger-ui-dist` (sem CDN: funciona
 * offline e no container). Só uma lista FECHADA de arquivos é servida: o nome
 * pedido nunca vira caminho no disco, então não há path traversal possível.
 */
import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { getAbsoluteFSPath } from 'swagger-ui-dist';
import { OPENAPI_DOCUMENT } from './openapi-document';

const ASSETS: Readonly<Record<string, string>> = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'application/javascript; charset=utf-8',
  'swagger-ui-standalone-preset.js': 'application/javascript; charset=utf-8',
  'favicon-32x32.png': 'image/png',
};

const HTML = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Distributed Wagering Processor — API</title>
  <link rel="icon" type="image/png" href="/docs/assets/favicon-32x32.png">
  <link rel="stylesheet" href="/docs/assets/swagger-ui.css">
  <style>
    /* O tema escuro do Swagger UI não recolore as descrições em markdown
       (tabelas de status ficavam cinza-escuro sobre fundo escuro). */
    @media (prefers-color-scheme: dark) {
      .swagger-ui .opblock-description-wrapper, .swagger-ui .markdown,
      .swagger-ui .markdown p, .swagger-ui .markdown li, .swagger-ui .markdown td,
      .swagger-ui .markdown th, .swagger-ui .renderedMarkdown p,
      .swagger-ui .response-col_description { color: #e6e6e6; }
      .swagger-ui .markdown table td, .swagger-ui .markdown table th { border-color: #555; }
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/assets/swagger-ui-bundle.js"></script>
  <script src="/docs/assets/swagger-ui-standalone-preset.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/docs/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      displayRequestDuration: true,
      tryItOutEnabled: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout'
    });
  </script>
</body>
</html>`;

@Controller('docs')
export class DocsController {
  private readonly assetsDir = getAbsoluteFSPath();

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return HTML;
  }

  @Get('openapi.json')
  spec(): typeof OPENAPI_DOCUMENT {
    return OPENAPI_DOCUMENT;
  }

  @Get('assets/:file')
  async asset(@Param('file') file: string, @Res() res: Response): Promise<void> {
    const contentType = ASSETS[file];
    if (contentType === undefined) throw new NotFoundException();
    const bytes = await Bun.file(`${this.assetsDir}/${file}`).arrayBuffer();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(Buffer.from(bytes));
  }
}

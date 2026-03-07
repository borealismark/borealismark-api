import { Router, type Request, type Response } from 'express';
import path from 'path';
import fs from 'fs';

const router = Router();

// Serve OpenAPI spec as YAML
router.get('/openapi.json', (_req: Request, res: Response) => {
  try {
    // Try to read from src directory first (development)
    let yamlPath = path.join(process.cwd(), 'src', 'docs', 'openapi.yaml');

    // Fallback to dist directory (production)
    if (!fs.existsSync(yamlPath)) {
      yamlPath = path.join(__dirname, '..', 'docs', 'openapi.yaml');
    }

    const yamlContent = fs.readFileSync(yamlPath, 'utf-8');

    // Serve YAML with appropriate content type
    res.setHeader('Content-Type', 'text/yaml');
    res.send(yamlContent);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load API specification' });
  }
});

// Serve Swagger UI HTML
router.get('/', (_req: Request, res: Response) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>BorealisMark Protocol API — Documentation</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.11.0/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; background: #0a0a1a; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui { max-width: 1200px; margin: 0 auto; }
    .swagger-ui .info .title { color: #00d4ff; }
    .swagger-ui .scheme-container { background: #1a1a2e; }
    .custom-header {
      background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3e 100%);
      padding: 24px 40px;
      border-bottom: 2px solid #00d4ff;
      text-align: center;
    }
    .custom-header h1 {
      color: #00d4ff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 28px;
      margin: 0 0 8px 0;
      letter-spacing: 2px;
    }
    .custom-header p {
      color: #8892b0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      margin: 0;
    }
  </style>
</head>
<body>
  <div class="custom-header">
    <h1>BOREALISMARK PROTOCOL API</h1>
    <p>Blockchain-Anchored AI Trust Infrastructure &bull; v1.2.0</p>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/v1/docs/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
      ],
      layout: 'BaseLayout',
      defaultModelsExpandDepth: 1,
      docExpansion: 'list',
      filter: true,
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

export default router;

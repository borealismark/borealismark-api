# @borealismark/sdk

Official TypeScript SDK for the **BorealisMark Protocol API** — Blockchain-Anchored AI Trust Infrastructure on Hedera Hashgraph.

## Installation

```bash
npm install @borealismark/sdk
```

## Quick Start

```typescript
import { BorealisMarkClient } from '@borealismark/sdk';

const client = new BorealisMarkClient({
  apiKey: 'your-api-key-here',
});

// Register an AI agent
const { agentId } = await client.agents.register({
  name: 'MyLLM',
  version: '2.0.0',
});

// Run a cryptographic audit
const certificate = await client.audit.submit({
  agentId,
  auditPeriod: {
    start: Date.now() - 30 * 24 * 60 * 60 * 1000,
    end: Date.now(),
  },
  constraints: [
    { name: 'Safety Filter', severity: 'critical', passed: true },
    { name: 'Data Privacy', severity: 'high', passed: true },
    { name: 'Bias Check', severity: 'medium', passed: true },
  ],
});

console.log(`Trust Score: ${certificate.score_total}/1000`);
console.log(`Credit Rating: ${certificate.credit_rating}`);
```

## API Reference

### BorealisMarkClient

#### `client.agents`
- `register(input)` — Register a new AI agent
- `get(agentId)` — Get agent details
- `getCertificate(agentId)` — Get latest certificate
- `listPublic(limit?, offset?)` — List public agents

#### `client.audit`
- `submit(input)` — Submit audit data and receive certificate

#### `client.keys`
- `create(input)` — Create API key (raw key returned once)
- `list()` — List all API keys
- `revoke(keyId, reason?)` — Revoke a key

#### `client.webhooks`
- `register(input)` — Register webhook endpoint
- `list()` — List webhooks
- `test(webhookId)` — Send test event
- `delete(webhookId)` — Delete webhook

#### `client.network`
- `consensus()` — Network statistics
- `topology()` — Network topology

#### `client.search`
- `agents(input?)` — Search public agents

## Error Handling

```typescript
import { RateLimitError, AuthenticationError } from '@borealismark/sdk';

try {
  await client.agents.listPublic();
} catch (err) {
  if (err instanceof RateLimitError) {
    console.log(`Rate limited. Resets at: ${err.resetsAt}`);
  } else if (err instanceof AuthenticationError) {
    console.log('Invalid API key');
  }
}
```

## Configuration

```typescript
const client = new BorealisMarkClient({
  apiKey: 'bm_live_...',
  baseUrl: 'https://borealismark-api.onrender.com', // default
  timeout: 30000, // ms, default
  headers: { 'X-Custom': 'value' }, // optional
});
```

## License

MIT — Borealis Protocol

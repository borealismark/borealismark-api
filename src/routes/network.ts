import { Router } from 'express';
import { requireApiKey } from '../middleware/auth';
import { getDb } from '../db/database';

const router = Router();

// ─── GET /v1/network/consensus ────────────────────────────────────────────────

router.get('/consensus', requireApiKey, (req, res) => {
  const db = getDb();

  // Recent audit activity (last 24 hours)
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recentAudits = (
    db.prepare('SELECT COUNT(*) as c FROM audit_certificates WHERE issued_at > ?').get(since) as { c: number }
  ).c;

  // Anchored on-chain
  const anchoredCount = (
    db.prepare('SELECT COUNT(*) as c FROM audit_certificates WHERE hcs_transaction_id IS NOT NULL').get() as { c: number }
  ).c;

  // Active nodes (distinct registrant keys that have submitted audits in 7 days)
  const nodesSince = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const activeAudits = db
    .prepare(
      'SELECT DISTINCT a.registrant_key_id FROM agents a JOIN audit_certificates c ON a.id = c.agent_id WHERE c.issued_at > ?',
    )
    .all(nodesSince) as Array<{ registrant_key_id: string }>;

  const networkStatus = recentAudits > 0 ? 'ACTIVE' : 'STANDBY';

  res.json({
    success: true,
    data: {
      status: networkStatus,
      auditsLast24h: recentAudits,
      totalAnchoredCertificates: anchoredCount,
      activeParticipants: activeAudits.length,
      consensusLayer: 'Hedera Hashgraph',
      topicId: process.env.HEDERA_AUDIT_TOPIC_ID ?? 'not-configured',
      network: process.env.HEDERA_NETWORK ?? 'testnet',
      protocolVersion: '1.0.0',
      timestamp: Date.now(),
    },
    timestamp: Date.now(),
  });
});

export default router;

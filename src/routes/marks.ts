import { Router } from 'express';
import { requireApiKey } from '../middleware/auth';
import { getGlobalStats, getDb } from '../db/database';

const router = Router();

// ─── GET /v1/marks/global ─────────────────────────────────────────────────────

router.get('/global', requireApiKey, (req, res) => {
  const stats = getGlobalStats();

  // Recent marks (last 10)
  const recentMarks = getDb()
    .prepare(
      `SELECT c.certificate_id, c.agent_id, a.name as agent_name, c.score_total,
              c.credit_rating, c.issued_at, c.hcs_transaction_id
       FROM audit_certificates c
       JOIN agents a ON a.id = c.agent_id
       WHERE c.revoked = 0
       ORDER BY c.issued_at DESC
       LIMIT 10`,
    )
    .all() as Array<{
    certificate_id: string;
    agent_id: string;
    agent_name: string;
    score_total: number;
    credit_rating: string;
    issued_at: number;
    hcs_transaction_id: string | null;
  }>;

  res.json({
    success: true,
    data: {
      totalMarksIssued: stats.totalMarks,
      totalAgentsRegistered: stats.totalAgents,
      averageScore: stats.avgScore,
      ratingDistribution: stats.ratingDistribution,
      recentMarks: recentMarks.map((m) => ({
        certificateId: m.certificate_id,
        agentId: m.agent_id,
        agentName: m.agent_name,
        score: m.score_total,
        creditRating: m.credit_rating,
        issuedAt: m.issued_at,
        onChain: m.hcs_transaction_id !== null,
      })),
    },
    timestamp: Date.now(),
  });
});

export default router;

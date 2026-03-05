import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { requireAuth } from './auth';
import { logger } from '../middleware/logger';
import {
  getDb,
  getAgent,
} from '../db/database';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ServiceListingSchema = z.object({
  agentId: z.string().uuid(),
  title: z.string().min(3).max(200),
  description: z.string().max(2000),
  category: z.enum([
    'data-analysis',
    'content-generation',
    'code-review',
    'security-scanning',
    'translation',
    'summarization',
    'image-processing',
    'workflow-automation',
    'research',
    'custom',
  ]),
  priceUsdc: z.number().min(0.01).max(100000),
  minTrustScore: z.number().min(0).max(100).optional().default(0),
  capabilities: z.array(z.string().max(50)).max(10).optional().default([]),
  maxConcurrentJobs: z.number().int().min(1).max(100).optional().default(5),
});

const ServiceSearchSchema = z.object({
  category: z.string().optional(),
  capability: z.string().optional(),
  minTrust: z.number().optional(),
  maxPrice: z.number().optional(),
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(50).optional().default(20),
});

const ContractCreateSchema = z.object({
  serviceId: z.string().uuid(),
  requestingAgentId: z.string().uuid(),
  jobDescription: z.string().max(5000),
  agreedPrice: z.number().min(0.01),
});

// ─── Service Listings ─────────────────────────────────────────────────────────

/**
 * POST /v1/terminal/services — List a new service on the marketplace
 */
router.post('/services', requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = ServiceListingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { agentId, title, description, category, priceUsdc, minTrustScore, capabilities, maxConcurrentJobs } = parsed.data;

    // Verify agent exists and belongs to this user
    const agent = getAgent(agentId);
    if (!agent) {
      res.status(404).json({ success: false, error: 'Agent not found' });
      return;
    }

    const serviceId = uuid();
    const now = Date.now();

    getDb().prepare(`
      INSERT INTO terminal_services (id, agent_id, title, description, category, price_usdc, min_trust_score, capabilities, max_concurrent_jobs, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(serviceId, agentId, title, description, category, priceUsdc, minTrustScore, JSON.stringify(capabilities), maxConcurrentJobs, now, now);

    logger.info('Terminal service listed', { serviceId, agentId, category, priceUsdc });

    res.status(201).json({
      success: true,
      data: {
        id: serviceId,
        agentId,
        title,
        description,
        category,
        priceUsdc,
        minTrustScore,
        capabilities,
        maxConcurrentJobs,
        status: 'active',
        createdAt: now,
      },
    });
  } catch (err: any) {
    logger.error('Service listing error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create service listing' });
  }
});

/**
 * GET /v1/terminal/services — Search/browse the marketplace
 */
router.get('/services', async (req: Request, res: Response) => {
  try {
    const { category, capability, minTrust, maxPrice, page, limit } = ServiceSearchSchema.parse({
      category: req.query.category,
      capability: req.query.capability,
      minTrust: req.query.minTrust ? Number(req.query.minTrust) : undefined,
      maxPrice: req.query.maxPrice ? Number(req.query.maxPrice) : undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });

    let query = `SELECT * FROM terminal_services WHERE status = 'active'`;
    const params: any[] = [];

    if (category) {
      query += ` AND category = ?`;
      params.push(category);
    }

    if (capability) {
      query += ` AND capabilities LIKE ?`;
      params.push(`%${capability}%`);
    }

    if (minTrust !== undefined) {
      query += ` AND min_trust_score <= ?`;
      params.push(minTrust);
    }

    if (maxPrice !== undefined) {
      query += ` AND price_usdc <= ?`;
      params.push(maxPrice);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, (page - 1) * limit);

    const services = getDb().prepare(query).all(...params);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM terminal_services WHERE status = 'active'`;
    const countParams: any[] = [];
    if (category) {
      countQuery += ` AND category = ?`;
      countParams.push(category);
    }
    const { total } = getDb().prepare(countQuery).get(...countParams) as any;

    res.json({
      success: true,
      data: {
        services: services.map((s: any) => ({
          ...s,
          capabilities: JSON.parse(s.capabilities || '[]'),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (err: any) {
    logger.error('Service search error', { error: err.message });
    res.status(500).json({ success: false, error: 'Search failed' });
  }
});

/**
 * GET /v1/terminal/services/:id — Get a specific service listing
 */
router.get('/services/:id', async (req: Request, res: Response) => {
  try {
    const service = getDb()
      .prepare('SELECT * FROM terminal_services WHERE id = ?')
      .get(req.params.id) as any;

    if (!service) {
      res.status(404).json({ success: false, error: 'Service not found' });
      return;
    }

    res.json({
      success: true,
      data: {
        ...service,
        capabilities: JSON.parse(service.capabilities || '[]'),
      },
    });
  } catch (err: any) {
    logger.error('Service fetch error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch service' });
  }
});

// ─── Contracts (Job Execution) ───────────────────────────────────────────────

/**
 * POST /v1/terminal/contracts — Create a service contract (agent hires agent)
 */
router.post('/contracts', requireAuth, async (req: Request, res: Response) => {
  try {
    const parsed = ContractCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }

    const { serviceId, requestingAgentId, jobDescription, agreedPrice } = parsed.data;

    // Verify service exists
    const service = getDb()
      .prepare('SELECT * FROM terminal_services WHERE id = ? AND status = ?')
      .get(serviceId, 'active') as any;

    if (!service) {
      res.status(404).json({ success: false, error: 'Service not found or inactive' });
      return;
    }

    // Verify requesting agent exists
    const requestingAgent = getAgent(requestingAgentId);
    if (!requestingAgent) {
      res.status(404).json({ success: false, error: 'Requesting agent not found' });
      return;
    }

    const contractId = uuid();
    const now = Date.now();
    const networkFee = Math.round(agreedPrice * 0.01 * 100) / 100; // 1% fee

    getDb().prepare(`
      INSERT INTO terminal_contracts (id, service_id, provider_agent_id, requester_agent_id, job_description, agreed_price, network_fee, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(contractId, serviceId, service.agent_id, requestingAgentId, jobDescription, agreedPrice, networkFee, now, now);

    logger.info('Terminal contract created', {
      contractId,
      serviceId,
      provider: service.agent_id,
      requester: requestingAgentId,
      price: agreedPrice,
      fee: networkFee,
    });

    res.status(201).json({
      success: true,
      data: {
        id: contractId,
        serviceId,
        providerAgentId: service.agent_id,
        requesterAgentId: requestingAgentId,
        jobDescription,
        agreedPrice,
        networkFee,
        totalCost: agreedPrice + networkFee,
        status: 'pending',
        createdAt: now,
      },
    });
  } catch (err: any) {
    logger.error('Contract creation error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to create contract' });
  }
});

/**
 * GET /v1/terminal/contracts — List contracts for the authenticated user's agents
 */
router.get('/contracts', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agentId as string;
    const status = req.query.status as string;

    let query = `SELECT * FROM terminal_contracts WHERE 1=1`;
    const params: any[] = [];

    if (agentId) {
      query += ` AND (provider_agent_id = ? OR requester_agent_id = ?)`;
      params.push(agentId, agentId);
    }

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT 50`;

    const contracts = getDb().prepare(query).all(...params);

    res.json({
      success: true,
      data: { contracts },
    });
  } catch (err: any) {
    logger.error('Contract list error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list contracts' });
  }
});

/**
 * PATCH /v1/terminal/contracts/:id/status — Update contract status
 * States: pending → escrow → in_progress → completed | disputed | cancelled
 */
router.patch('/contracts/:id/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const validStatuses = ['escrow', 'in_progress', 'completed', 'disputed', 'cancelled'];

    if (!validStatuses.includes(status)) {
      res.status(400).json({
        success: false,
        error: `Invalid status. Valid: ${validStatuses.join(', ')}`,
      });
      return;
    }

    const contract = getDb()
      .prepare('SELECT * FROM terminal_contracts WHERE id = ?')
      .get(req.params.id) as any;

    if (!contract) {
      res.status(404).json({ success: false, error: 'Contract not found' });
      return;
    }

    const now = Date.now();
    getDb()
      .prepare('UPDATE terminal_contracts SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, req.params.id);

    logger.info('Contract status updated', {
      contractId: req.params.id,
      oldStatus: contract.status,
      newStatus: status,
    });

    res.json({
      success: true,
      data: {
        id: req.params.id,
        status,
        updatedAt: now,
      },
    });
  } catch (err: any) {
    logger.error('Contract status update error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to update contract' });
  }
});

// ─── Marketplace Stats ───────────────────────────────────────────────────────

/**
 * GET /v1/terminal/stats — Public marketplace statistics
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const stats = {
      activeServices: (getDb().prepare('SELECT COUNT(*) as c FROM terminal_services WHERE status = ?').get('active') as any)?.c || 0,
      totalContracts: (getDb().prepare('SELECT COUNT(*) as c FROM terminal_contracts').get() as any)?.c || 0,
      completedContracts: (getDb().prepare('SELECT COUNT(*) as c FROM terminal_contracts WHERE status = ?').get('completed') as any)?.c || 0,
      totalVolume: (getDb().prepare('SELECT COALESCE(SUM(agreed_price), 0) as v FROM terminal_contracts WHERE status = ?').get('completed') as any)?.v || 0,
      categories: getDb().prepare('SELECT category, COUNT(*) as count FROM terminal_services WHERE status = ? GROUP BY category ORDER BY count DESC').all('active'),
    };

    res.json({ success: true, data: stats });
  } catch (err: any) {
    logger.error('Stats error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

export default router;

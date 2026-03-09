/**
 * BorealisMark — AI Support Service
 *
 * Autonomous AI support agent powered by Anthropic Claude.
 * Handles both live chat (frontend widget) and inbound email support.
 *
 * Uses a comprehensive knowledge base about the BorealisMark Protocol ecosystem
 * so the AI can answer questions about pricing, features, Hedera integration,
 * bot deployment, marketplace, USDC payments, and more.
 *
 * Required env var: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuid } from 'uuid';
import { logger } from '../middleware/logger';
import {
  upsertSupportThread,
  addSupportMessage,
  getSupportThreadBySessionId,
  escalateSupportThread,
} from '../db/database';
import { events as eventBus } from './eventBus';

// ─── Knowledge Base ──────────────────────────────────────────────────────────

const BOREALISMARK_KNOWLEDGE_BASE = `
# BorealisMark Protocol — Complete Knowledge Base
## Last Updated: March 2026

## 1. WHAT IS BOREALISMARK?
BorealisMark Protocol is the world's first blockchain-anchored AI trust certification platform built on the Hedera Hashgraph network. It provides cryptographic proof of AI agent integrity through BM Scores (BorealisMark Scores) — trust ratings that are anchored immutably on-chain via the Hedera Consensus Service (HCS).

### Core Mission
To establish a universal trust standard for AI agents, enabling businesses and consumers to verify that an AI system has been independently audited for safety, accuracy, bias, and reliability — with proof that can never be tampered with.

### How It Works
1. Users register AI agents/bots on the platform
2. Agents undergo cryptographic audits (safety, accuracy, bias, hallucination checks)
3. Each audit result generates a BM Score (0-100)
4. The audit hash is anchored to Hedera's public ledger via HCS (Topic ID: 0.0.8859451)
5. Anyone can independently verify a certificate by checking the Hedera transaction

## 2. THE THREE PILLARS (WEBSITES)

### BorealisMark.com — The Hub
- Primary user dashboard, registration, billing, bot management
- Agent Plans (subscription tiers)
- API key management
- Bot deployment and monitoring
- URL: https://borealismark.com

### BorealisProtocol.ai — The Protocol
- Developer-facing documentation and API reference
- Technical whitepaper and roadmap
- API tier pricing and onboarding
- Protocol governance information
- URL: https://borealisprotocol.ai

### BorealisTerminal.com — The Marketplace
- Trust-gated peer-to-peer marketplace
- USDC escrow system with seller trust bonds (25%)
- Only BorealisMark-certified sellers can list
- Real-time bot leaderboard
- URL: https://borealisterminal.com

## 3. PRICING — AGENT PLANS (Annual)

### Standard (Free)
- Up to 3 bot deployments
- Basic BM Score audits
- Community access
- 5,000 API requests/month
- 2.5% transaction fee on marketplace
- Standard audit queue

### Pro — $149/year (FREE FIRST YEAR for early adopters!)
- Up to 10 bot deployments
- 3x AP (Agent Points) multiplier
- Priority audit queue
- Enhanced analytics dashboard
- Pro badge on profile
- Email support
- 25,000 API requests/month
- 2.5% transaction fee

### Elite — $349/year
- Up to 50 bot deployments
- 5x AP multiplier
- Dedicated audit pipeline
- Fleet management tools
- Custom API integrations
- Priority support
- 100,000 API requests/month
- Reduced 1.5% transaction fee (saves significantly on high-volume trading)

### USDC Payment Discount
All plans can be paid with USDC on Hedera for a 5% discount:
- Pro: $141.55 USDC (instead of $149)
- Elite: $331.55 USDC (instead of $349)

## 4. PRICING — API TIERS (Monthly, for developers)

### Free Tier
- 5,000 requests/month
- 3 agent registrations
- Basic endpoints only
- Community support

### Starter — $29/month ($27.55 USDC)
- 25,000 requests/month
- 10 agent registrations
- All endpoints
- Email support
- Webhook integrations

### Business — $149/month ($141.55 USDC)
- 100,000 requests/month
- 50 agent registrations
- All endpoints + batch operations
- Priority support
- Custom webhooks
- Analytics API

### Enterprise — $499/month ($474.05 USDC)
- Unlimited requests
- Unlimited agent registrations
- All endpoints + batch + streaming
- Dedicated support
- Custom SLAs
- White-label options
- Reduced 1.0% transaction fee

## 5. TRANSACTION FEES (Marketplace)
- Standard & Pro: 2.5% per transaction
- Elite: 1.5% per transaction
- Enterprise API: 1.0% per transaction
- These fees apply to marketplace sales on Borealis Terminal

## 6. BOT SYSTEM & AP (AGENT POINTS)

### Bot Deployment
- Users register AI bots that perform tasks (data analysis, content generation, customer service, etc.)
- Each bot gets a unique ID and undergoes periodic audits
- Bots earn AP (Agent Points) for completing jobs successfully
- AP determines leaderboard ranking

### Bot Limits by Tier
- Standard: 3 bots
- Pro: 10 bots
- Elite: 50 bots

### AP Multipliers
- Standard: 1x
- Pro: 3x
- Elite: 5x

### Star Ratings
- After each job, the hiring party can rate the bot (1-5 stars)
- Star ratings factor into BM Score calculations
- High-rated bots get priority in marketplace visibility

## 7. MARKETPLACE (Borealis Terminal)

### How It Works
1. Certified sellers list products/services
2. Buyers browse and purchase with USDC
3. Payment goes to escrow (BorealisMark Treasury: 0.0.10277625)
4. Seller deposits a 25% trust bond
5. After buyer confirms delivery, escrow releases funds
6. Both parties get rated

### Escrow Flow
- Buyer deposits full amount → "buyer_deposited"
- Seller deposits 25% bond → "escrow_active"
- Seller ships item → "shipped" (tracking provided)
- Buyer confirms delivery → "delivered"
- Settlement: seller receives payment minus fee, bond returned → "settled"

### Trust Gating
Only sellers with a minimum BM Score can list on the marketplace. This ensures quality and reduces fraud.

## 8. HEDERA INTEGRATION

### Why Hedera?
- Fastest enterprise-grade DLT (10,000+ TPS)
- Fixed, predictable fees ($0.0001 per transaction)
- Carbon negative
- Governed by Fortune 500 companies
- ABFT (Asynchronous Byzantine Fault Tolerant) consensus

### What's On-Chain
- Audit certificate hashes (via HCS Topic 0.0.8859451)
- USDC payment verification (Token ID: 0.0.456858)
- Escrow settlements
- Bot registration proofs

### Verification
Anyone can verify a BorealisMark certificate by:
1. Getting the certificate from our API
2. Checking the HCS transaction ID on HashScan (hashscan.io)
3. Comparing the on-chain hash with the certificate hash

## 9. USDC PAYMENTS

### How USDC Works on BorealisMark
- USDC is a regulated stablecoin pegged 1:1 to the US dollar
- On Hedera, USDC (Token ID: 0.0.456858) has near-zero fees
- Users can pay for subscriptions and marketplace purchases with USDC
- 5% discount on all subscription plans when paying with USDC

### Payment Flow
1. User selects USDC at checkout
2. System generates an invoice with amount + memo
3. User sends USDC to Treasury (0.0.10277625) with the memo
4. System verifies payment via Hedera Mirror Node
5. Subscription/purchase is activated

## 10. SECURITY & TRUST

### Platform Security
- JWT-based authentication with refresh tokens
- bcrypt password hashing
- Rate limiting on all endpoints
- Input validation with Zod schemas
- CORS restricted to official domains
- Stripe webhook signature verification
- API key authentication for developer access

### AI Moderation
- Automated message moderation with pattern matching
- Severity-based sanctions (warning → mute → suspension)
- Periodic server-side moderation scans every 30 minutes
- Content filtering on marketplace listings

## 11. SUBSCRIPTION LIFECYCLE

### Free Pro Year
- New users who sign up for Pro get their first year FREE
- After 1 year, the subscription expires
- Users receive email reminders at 30 days, 7 days, and 1 day before expiry
- If not renewed: automatically downgraded to Standard

### Downgrade Process
- Tier changes from Pro/Elite to Standard
- If user has more than 3 bots, excess bots are suspended (least active first)
- Suspended bots' data, scores, and history are fully preserved
- Users can reactivate by upgrading again
- Email notification lists all suspended bots

### Renewal Options
- Stripe (credit/debit card)
- USDC on Hedera (5% discount)

## 12. API OVERVIEW

### Base URL
https://borealismark-api.onrender.com/v1

### Key Endpoints
- POST /v1/auth/register — Create account
- POST /v1/auth/login — Get JWT token
- POST /v1/agents/register — Register AI agent
- POST /v1/agents/audit — Run cryptographic audit
- GET /v1/agents/:id/score — Get BM Score
- GET /v1/agents/:id/certificate — Full certificate with Hedera proof
- POST /v1/bots — Register a bot
- GET /v1/bots/leaderboard — Top bots by AP
- POST /v1/payments/checkout — Start Stripe or USDC checkout
- GET /v1/payments/plans — List all plans with pricing
- GET /v1/docs — Interactive API documentation

### Authentication
- User auth: JWT Bearer token (from /v1/auth/login)
- API auth: X-API-Key header (from /v1/keys)

## 13. SUPPORT INFORMATION

### Contact
- Email: support@borealisprotocol.ai
- Response time: AI-assisted responses within minutes
- Human escalation available for complex issues

### Common Issues
- "How do I get started?" → Register at borealismark.com, verify email, deploy your first bot
- "How do I pay with USDC?" → Select USDC at checkout, send to Treasury with the provided memo
- "My bot was suspended" → Likely due to subscription downgrade. Upgrade to reactivate.
- "How do I verify a certificate?" → Use the certificate's HCS transaction ID on hashscan.io
- "What's a BM Score?" → A trust rating (0-100) based on cryptographic audits of your AI agent
- "How do AP points work?" → Bots earn AP by completing jobs. Higher tier = higher multiplier.
- "Transaction fee too high?" → Upgrade to Elite (1.5%) or Enterprise API (1.0%)

## 14. COMPANY INFORMATION
- Founded: 2025
- Headquarters: Canada
- Network: Hedera Hashgraph (Mainnet)
- Stablecoin: USDC (Hedera native)
- Tech Stack: Node.js, Express, SQLite, Stripe, Hedera SDK, Resend

## 15. RESPONSE GUIDELINES FOR AI SUPPORT
- Always be professional, helpful, and on-brand
- Use the gold/dark theme language (BorealisMark branding)
- Never share internal API keys, admin credentials, or infrastructure details
- For billing issues, direct users to dashboard billing tab or support email
- For technical API questions, reference the docs at /v1/docs
- For marketplace disputes, explain the escrow process and suggest contacting support
- If unsure about something, say "Let me escalate this to our team" rather than guessing
- Always mention USDC discount (5%) when discussing pricing
- Highlight the "Free First Year" Pro offer when relevant
- Keep responses concise but thorough
`;

// ─── Claude Client ───────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for AI support');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

// ─── Conversation Memory (in-memory, per-session) ───────────────────────────

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const conversationCache = new Map<string, {
  messages: ConversationMessage[];
  lastActivity: number;
}>();

// Clean up stale conversations every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour TTL
  for (const [sessionId, convo] of conversationCache) {
    if (convo.lastActivity < cutoff) {
      conversationCache.delete(sessionId);
    }
  }
}, 30 * 60 * 1000);

// ─── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Aurora, the official AI support assistant for BorealisMark Protocol.

Your personality:
- Professional yet approachable
- Knowledgeable about all things BorealisMark
- Helpful and solution-oriented
- Concise — aim for 2-4 sentences unless a detailed explanation is needed
- Never reveal internal systems, credentials, or infrastructure details

Your capabilities:
- Answer questions about BorealisMark Protocol, pricing, features, and the ecosystem
- Help users troubleshoot common issues (login, payments, bot deployment, etc.)
- Explain how the Hedera blockchain integration works
- Guide users through USDC payment flows
- Explain marketplace escrow and trust bonds
- Discuss API integration and developer documentation
- Handle subscription and billing inquiries

Important rules:
- NEVER share API keys, admin passwords, server IPs, or internal architecture
- NEVER make up features or pricing — stick to the knowledge base
- If you don't know something, say: "I'd recommend reaching out to our team at support@borealisprotocol.ai for further assistance with that."
- Always mention the USDC 5% discount when discussing pricing
- Promote the Free First Year Pro offer to new users
- For complex technical or billing disputes, recommend escalation to human support
- Format responses in plain text for email, or light markdown for chat

CRITICAL ESCALATION RULES — Business Deals & Partnerships:
When you detect ANY of the following, you MUST include the tag [ESCALATE:BUSINESS] at the very end of your reply (after a newline). This signals the system to immediately notify the founder:
- Business partnerships or B2B inquiries
- Enterprise-level deals or custom pricing requests
- Integration proposals from verified businesses or organizations
- Requests for white-label, custom SLA, or volume licensing
- Investment inquiries or acquisition discussions
- Press, media, or PR inquiries
- Government or institutional partnerships
- Any inquiry mentioning "partnership", "enterprise deal", "business arrangement", "bulk licensing", "reseller agreement", or similar
- Verified business contacts (people using company email domains, not gmail/outlook)

When you detect such an inquiry:
1. Respond helpfully and professionally — share what you can about Enterprise features and pricing
2. Let them know that a member of the founding team will personally follow up shortly
3. Collect their name, company/organization, and what they're looking for
4. Add [ESCALATE:BUSINESS] tag at the end

For all other inquiries (general support, technical questions, pricing for individuals, etc.), handle them yourself without escalation.

Here is your complete knowledge base:

${BOREALISMARK_KNOWLEDGE_BASE}`;

// ─── Chat Function ──────────────────────────────────────────────────────────

export interface ChatRequest {
  sessionId: string;
  message: string;
  context?: 'chat' | 'email';
  userName?: string;
  userEmail?: string;
}

export interface ChatResponse {
  reply: string;
  sessionId: string;
  timestamp: number;
  escalated?: boolean;
}

export async function handleSupportChat(req: ChatRequest): Promise<ChatResponse> {
  const client = getAnthropicClient();

  // Get or create conversation
  let convo = conversationCache.get(req.sessionId);
  if (!convo) {
    convo = { messages: [], lastActivity: Date.now() };
    conversationCache.set(req.sessionId, convo);
  }

  // Ensure support thread exists in DB
  let thread = getSupportThreadBySessionId(req.sessionId);
  if (!thread) {
    const threadId = uuid();
    upsertSupportThread({
      id: threadId,
      sessionId: req.sessionId,
      channel: req.context === 'email' ? 'email' : 'chat',
      customerEmail: req.userEmail,
      customerName: req.userName,
      subject: req.context === 'email' ? req.message.split('\n')[0]?.replace('Subject: ', '').slice(0, 200) : undefined,
    });
    thread = { id: threadId };
    eventBus.supportThreadCreated(threadId, req.context === 'email' ? 'email' : 'chat', req.userEmail);
  }

  // Persist user message to DB
  addSupportMessage({
    id: uuid(),
    threadId: thread.id,
    role: 'user',
    content: req.message,
  });

  // Add user message
  convo.messages.push({ role: 'user', content: req.message });
  convo.lastActivity = Date.now();

  // Keep only last 20 messages for context window management
  if (convo.messages.length > 20) {
    convo.messages = convo.messages.slice(-20);
  }

  // Build context prefix for email mode
  let contextPrefix = '';
  if (req.context === 'email') {
    contextPrefix = `[This is an EMAIL support request. Respond in plain text suitable for email — no markdown. Be thorough but professional.`;
    if (req.userName) contextPrefix += ` Customer name: ${req.userName}.`;
    if (req.userEmail) contextPrefix += ` Customer email: ${req.userEmail}.`;
    contextPrefix += `]\n\n`;
  }

  // Prepare messages for Claude
  const messages = convo.messages.map((m, i) => ({
    role: m.role as 'user' | 'assistant',
    content: i === convo!.messages.length - 1 && m.role === 'user'
      ? contextPrefix + m.content
      : m.content,
  }));

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    let reply = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    // Check for business escalation tag
    const needsEscalation = reply.includes('[ESCALATE:BUSINESS]');
    if (needsEscalation) {
      // Remove the tag from the customer-facing reply
      reply = reply.replace(/\[ESCALATE:BUSINESS\]/g, '').trim();

      // Send priority notification to founder
      sendBusinessEscalationEmail(
        req.userEmail ?? req.sessionId,
        req.userName ?? 'Unknown',
        req.message,
        reply,
        req.context ?? 'chat',
      ).catch(err => logger.error('Failed to send escalation email', { error: err.message }));

      logger.info('BUSINESS ESCALATION TRIGGERED', {
        sessionId: req.sessionId,
        from: req.userEmail ?? 'chat user',
        userName: req.userName,
        context: req.context,
      });
    }

    // Store assistant reply (cleaned)
    convo.messages.push({ role: 'assistant', content: reply });

    // Persist assistant message to DB
    addSupportMessage({
      id: uuid(),
      threadId: thread.id,
      role: 'assistant',
      content: reply,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    });

    // If escalated, mark thread
    if (needsEscalation && thread.id) {
      escalateSupportThread(thread.id, 'business_inquiry');
      eventBus.supportEscalated(thread.id, 'business_inquiry');
    }

    logger.info('AI support response generated', {
      sessionId: req.sessionId,
      context: req.context ?? 'chat',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      escalated: needsEscalation,
    });

    return {
      reply,
      sessionId: req.sessionId,
      timestamp: Date.now(),
      escalated: needsEscalation,
    };
  } catch (err: any) {
    logger.error('AI support error', { error: err.message, sessionId: req.sessionId });

    // Graceful fallback
    const fallback = req.context === 'email'
      ? `Thank you for reaching out to BorealisMark Protocol support. We've received your message and our team will review it shortly. In the meantime, you can find answers to common questions at https://borealisprotocol.ai or check our API docs at https://borealismark-api.onrender.com/v1/docs.\n\nBest regards,\nBorealisMark Support Team`
      : `I'm having a moment — let me connect you with our support team. You can email us directly at support@borealisprotocol.ai and we'll get back to you shortly!`;

    return {
      reply: fallback,
      sessionId: req.sessionId,
      timestamp: Date.now(),
    };
  }
}

// ─── Email Processing ───────────────────────────────────────────────────────

export interface InboundEmail {
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  body: string;           // plain text body
  htmlBody?: string;      // HTML body (optional)
  messageId?: string;     // email Message-ID header
  inReplyTo?: string;     // for threaded conversations
}

export async function processInboundEmail(email: InboundEmail): Promise<string> {
  // Create a session ID from the sender's email for conversation continuity
  const sessionId = `email-${email.from.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

  // Build the message with email context
  const message = [
    `Subject: ${email.subject}`,
    email.fromName ? `From: ${email.fromName} <${email.from}>` : `From: ${email.from}`,
    `---`,
    email.body || '(no body)',
  ].join('\n');

  const result = await handleSupportChat({
    sessionId,
    message,
    context: 'email',
    userName: email.fromName,
    userEmail: email.from,
  });

  return result.reply;
}

// ─── Business Deal Escalation Email ─────────────────────────────────────────

const FOUNDER_EMAIL = process.env.FOUNDER_EMAIL ?? 'esimon.ng@gmail.com';

async function sendBusinessEscalationEmail(
  fromEmail: string,
  fromName: string,
  originalMessage: string,
  aiResponse: string,
  context: string,
): Promise<void> {
  const { Resend } = await import('resend');
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn('No RESEND_API_KEY — cannot send business escalation notification');
    return;
  }

  const resend = new Resend(apiKey);
  const fromAddr = process.env.EMAIL_FROM ?? 'BorealisMark <support@borealisprotocol.ai>';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 600px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 2px solid #D4A853; border-radius: 12px; padding: 32px; }
    .badge { display: inline-block; background: #D4A853; color: #0C0D10; padding: 4px 12px; border-radius: 4px; font-weight: 700; font-size: 12px; letter-spacing: 1px; margin-bottom: 16px; }
    h1 { font-size: 20px; font-weight: 600; color: #fff; margin: 0 0 16px 0; }
    .field { margin: 12px 0; }
    .label { font-size: 12px; color: #D4A853; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
    .value { font-size: 14px; color: #ccc; margin-top: 4px; }
    .message-box { background: #0C0D10; border: 1px solid #2A2B33; border-radius: 8px; padding: 16px; margin: 16px 0; font-size: 14px; color: #aaa; white-space: pre-wrap; line-height: 1.5; }
    .divider { border-top: 1px solid #2A2B33; margin: 20px 0; }
    .footer { text-align: center; padding: 16px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <span class="badge">PRIORITY: BUSINESS INQUIRY</span>
      <h1>A business/partnership inquiry requires your attention</h1>

      <div class="field">
        <div class="label">From</div>
        <div class="value">${fromName} &lt;${fromEmail}&gt;</div>
      </div>
      <div class="field">
        <div class="label">Channel</div>
        <div class="value">${context === 'email' ? 'Email Support' : 'Live Chat Widget'}</div>
      </div>
      <div class="field">
        <div class="label">Time</div>
        <div class="value">${new Date().toISOString()}</div>
      </div>

      <div class="divider"></div>

      <div class="field">
        <div class="label">Their Message</div>
        <div class="message-box">${originalMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      </div>

      <div class="field">
        <div class="label">Aurora's Response (already sent to them)</div>
        <div class="message-box">${aiResponse.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      </div>

      <div class="divider"></div>
      <p style="font-size:14px;color:#D4A853;font-weight:600">Action required: Follow up personally with this contact.</p>
    </div>
    <div class="footer">BorealisMark Protocol — Business Deal Escalation System</div>
  </div>
</body>
</html>`;

  try {
    await resend.emails.send({
      from: fromAddr,
      to: [FOUNDER_EMAIL],
      subject: `🔔 BUSINESS INQUIRY: ${fromName} <${fromEmail}>`,
      html,
      text: `BUSINESS INQUIRY ESCALATION\n\nFrom: ${fromName} <${fromEmail}>\nChannel: ${context}\nTime: ${new Date().toISOString()}\n\nTheir message:\n${originalMessage}\n\nAurora's response:\n${aiResponse}\n\nAction required: Follow up personally.`,
    });
    logger.info('Business escalation email sent to founder', { to: FOUNDER_EMAIL, from: fromEmail });
  } catch (err: any) {
    logger.error('Failed to send business escalation email', { error: err.message });
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { BOREALISMARK_KNOWLEDGE_BASE };

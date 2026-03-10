/**
 * BorealisMark — AI Support Routes
 *
 * POST /v1/support/chat           — Frontend chat widget messages
 * POST /v1/support/email-inbound  — Inbound email webhook (from Cloudflare Email Workers)
 * GET  /v1/support/health         — Support service health check
 */

import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { handleSupportChat, processInboundEmail, type InboundEmail } from '../services/aiSupport';
import { logger } from '../middleware/logger';
import { storeInboundEmail, storeOutboundEmail } from './adminMail';

// We import the Resend send function to reply to emails
import { Resend } from 'resend';

const router = Router();

// CRITICAL: Outbound emails MUST use verified branded domains — NEVER *.cloudflare.dev or *.workers.dev
const FROM_ADDRESS = process.env.EMAIL_FROM ?? 'BorealisMark Support <support@borealisprotocol.ai>';
const VERIFY_FROM_ADDRESS = 'Borealis Terminal Verification <verify@borealisprotocol.ai>';

// Safety: ensure FROM addresses never use .dev or workers.dev domains
function getSafeFromAddress(address: string): string {
  if (address.includes('.workers.dev') || address.includes('.pages.dev') || address.includes('cloudflare.dev')) {
    logger.warn('Blocked outbound email from .dev domain', { attempted: address });
    return FROM_ADDRESS; // fallback to the verified branded domain
  }
  return address;
}

// ─── Rate limiting for chat (simple in-memory) ──────────────────────────────

const chatRateLimit = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = chatRateLimit.get(ip);

  if (!entry || entry.resetAt < now) {
    chatRateLimit.set(ip, { count: 1, resetAt: now + 60_000 }); // 1 min window
    return false;
  }

  entry.count++;
  return entry.count > 10; // max 10 messages per minute
}

// Clean up rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of chatRateLimit) {
    if (entry.resetAt < now) chatRateLimit.delete(ip);
  }
}, 5 * 60 * 1000);

// ─── POST /chat — Frontend chat widget ──────────────────────────────────────

router.post('/chat', async (req: Request, res: Response) => {
  try {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({
        success: false,
        error: 'Too many messages. Please wait a moment before sending another.',
      });
    }

    const { message, sessionId, userName } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Message is required',
      });
    }

    if (message.length > 2000) {
      return res.status(400).json({
        success: false,
        error: 'Message too long (max 2000 characters)',
      });
    }

    const result = await handleSupportChat({
      sessionId: sessionId || `chat-${uuid()}`,
      message: message.trim(),
      context: 'chat',
      userName: userName || undefined,
    });

    res.json({
      success: true,
      data: {
        reply: result.reply,
        sessionId: result.sessionId,
        timestamp: result.timestamp,
      },
    });
  } catch (err: any) {
    logger.error('Support chat error', { error: err.message });
    res.status(500).json({
      success: false,
      error: 'Support service temporarily unavailable. Please email support@borealisprotocol.ai.',
    });
  }
});

// ─── POST /email-inbound — Cloudflare Email Workers webhook ─────────────────

router.post('/email-inbound', async (req: Request, res: Response) => {
  try {
    // Verify webhook secret (set in Cloudflare Worker)
    const webhookSecret = process.env.SUPPORT_WEBHOOK_SECRET;
    if (webhookSecret && req.headers['x-webhook-secret'] !== webhookSecret) {
      logger.warn('Invalid support webhook secret');
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { from, fromName, to, subject, body, htmlBody, messageId, inReplyTo } = req.body as InboundEmail;

    if (!from || !body) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: from, body',
      });
    }

    logger.info('Inbound support email received', {
      from, subject, messageId,
    });

    // Store inbound email in admin mail center
    let inboundMailId: string | undefined;
    try {
      inboundMailId = storeInboundEmail({
        from, fromName, subject: subject || '(no subject)',
        bodyText: body, bodyHtml: htmlBody,
        messageId, inReplyTo, source: 'support',
      });
    } catch (storeErr: any) {
      logger.error('Failed to store inbound email in admin mail', { error: storeErr.message });
    }

    // Generate AI reply
    const aiReply = await processInboundEmail({
      from, fromName, to, subject, body, htmlBody, messageId, inReplyTo,
    });

    // Send the reply via Resend
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
      const resend = new Resend(apiKey);
      const emailHtml = buildSupportReplyHtml(fromName || from.split('@')[0], subject, aiReply);

      // Use branded FROM address — verification emails use verify@, all others use support@
      const isVerificationEmail = to?.toLowerCase().includes('verify@borealisterminal.com');
      const replyFrom = getSafeFromAddress(isVerificationEmail ? VERIFY_FROM_ADDRESS : FROM_ADDRESS);
      const sigLine = isVerificationEmail
        ? 'Aurora — Borealis Terminal Verification\nverify@borealisterminal.com\nhttps://borealisterminal.com'
        : 'Aurora — BorealisMark AI Support\nsupport@borealisprotocol.ai\nhttps://borealisprotocol.ai';

      const result = await resend.emails.send({
        from: replyFrom,
        to: [from],
        subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
        html: emailHtml,
        text: `Hi ${fromName || 'there'},\n\n${aiReply}\n\n---\n${sigLine}`,
        ...(messageId ? { headers: { 'In-Reply-To': messageId, 'References': messageId } } : {}),
      });

      if (result.error) {
        logger.error('Failed to send support reply email', { error: result.error, to: from });
      } else {
        logger.info('Support reply sent', { to: from, subject, emailId: result.data?.id });
        // Store outbound reply in admin mail center
        try {
          storeOutboundEmail({
            to: from, subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
            bodyText: aiReply, bodyHtml: emailHtml,
            resendId: result.data?.id, source: 'aurora-reply',
          });
        } catch (storeErr: any) {
          logger.error('Failed to store outbound email in admin mail', { error: storeErr.message });
        }
      }
    } else {
      logger.warn('No RESEND_API_KEY — support reply not sent', { to: from, subject });
    }

    res.json({ success: true, message: 'Email processed and reply sent' });
  } catch (err: any) {
    logger.error('Inbound email processing error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to process email' });
  }
});

// ─── GET /health — Support service health ───────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasResendKey = !!process.env.RESEND_API_KEY;

  res.json({
    success: true,
    data: {
      status: hasAnthropicKey ? 'operational' : 'degraded',
      aiEnabled: hasAnthropicKey,
      emailEnabled: hasResendKey,
      agent: 'Aurora',
      version: '1.0.0',
    },
  });
});

// ─── Helper: Build HTML email reply ─────────────────────────────────────────

function buildSupportReplyHtml(customerName: string, subject: string, reply: string): string {
  // Convert plain text reply to HTML paragraphs
  const htmlBody = reply
    .split('\n\n')
    .map(p => `<p style="font-size:15px;line-height:1.6;color:#A0A0A0;margin:0 0 16px 0">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 8px; }
    .subtitle { font-size: 13px; color: #666; margin-bottom: 24px; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
    a { color: #D4A853; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <div class="subtitle">AI Support — Aurora</div>
      <p style="font-size:15px;line-height:1.6;color:#A0A0A0;margin:0 0 16px 0">Hi ${customerName},</p>
      ${htmlBody}
      <div class="divider"></div>
      <p class="small">This response was generated by Aurora, our AI support assistant. If you need further help or want to speak with a human, just reply to this email and we'll escalate your request.</p>
      <p class="small" style="margin-top:12px">
        <a href="https://borealismark.com">Dashboard</a> &nbsp;·&nbsp;
        <a href="https://borealisprotocol.ai">Protocol Docs</a> &nbsp;·&nbsp;
        <a href="https://borealisterminal.com">Marketplace</a>
      </p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol &mdash; AI Trust Certification on Hedera
    </div>
  </div>
</body>
</html>`;
}

export default router;

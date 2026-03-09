/**
 * BorealisMark — Email Service
 *
 * Sends transactional emails via Resend (https://resend.com).
 * Uses support@borealisprotocol.ai as the sender.
 *
 * Required env var: RESEND_API_KEY
 */

import { Resend } from 'resend';
import { logger } from '../middleware/logger';

// Use custom domain if verified in Resend, otherwise fall back to Resend's test sender
const FROM_ADDRESS = process.env.EMAIL_FROM ?? 'BorealisMark <onboarding@resend.dev>';

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      logger.warn('RESEND_API_KEY not set — emails will be logged but not sent');
    }
    resend = new Resend(apiKey ?? 're_dummy_key');
  }
  return resend;
}

/**
 * Send a password reset email with a secure link.
 */
export async function sendPasswordResetEmail(
  toEmail: string,
  resetToken: string,
  userName: string,
): Promise<boolean> {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://borealisterminal.com';
  const resetLink = `${frontendUrl}?reset=${resetToken}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .btn:hover { background: #E0B85C; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .link { color: #D4A853; word-break: break-all; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <h1>Reset your password</h1>
      <p>Hi ${userName || 'there'},</p>
      <p>We received a request to reset the password for your BorealisMark account. Click the button below to choose a new password:</p>
      <a href="${resetLink}" class="btn">Reset Password</a>
      <p class="small">This link will expire in <strong style="color:#fff">1 hour</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
      <div class="divider"></div>
      <p class="small">If the button doesn't work, copy and paste this link into your browser:</p>
      <p class="small link">${resetLink}</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol &mdash; AI Trust Certification on Hedera
    </div>
  </div>
</body>
</html>`;

  const text = `Reset your BorealisMark password

Hi ${userName || 'there'},

We received a request to reset the password for your BorealisMark account. Visit the link below to choose a new password:

${resetLink}

This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.

— BorealisMark Protocol`;

  // If no API key, log the email instead of sending
  if (!process.env.RESEND_API_KEY) {
    logger.info('Password reset email (NOT SENT — no RESEND_API_KEY)', {
      to: toEmail,
      resetLink,
    });
    return true; // Return true so the flow continues in development
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: 'Reset your BorealisMark password',
      html,
      text,
    });

    if (result.error) {
      logger.error('Email send failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Password reset email sent', { to: toEmail, id: result.data?.id });
    return true;
  } catch (err: any) {
    logger.error('Email service error', { error: err.message, to: toEmail });
    return false;
  }
}

/**
 * Send a verification email after registration.
 */
export async function sendVerificationEmail(
  toEmail: string,
  verificationToken: string,
  userName: string,
): Promise<boolean> {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://borealisterminal.com';
  const verifyLink = `${frontendUrl}?verify=${verificationToken}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .btn:hover { background: #E0B85C; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .link { color: #D4A853; word-break: break-all; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <h1>Verify your email address</h1>
      <p>Hi ${userName || 'there'},</p>
      <p>Welcome to the BorealisMark Protocol ecosystem. To complete your registration and unlock full access to the trust-gated marketplace, please verify your email address:</p>
      <a href="${verifyLink}" class="btn">Verify Email</a>
      <p class="small">This link will expire in <strong style="color:#fff">24 hours</strong>. If you didn't create this account, you can safely ignore this email.</p>
      <div class="divider"></div>
      <p class="small">If the button doesn't work, copy and paste this link into your browser:</p>
      <p class="small link">${verifyLink}</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol &mdash; AI Trust Certification on Hedera
    </div>
  </div>
</body>
</html>`;

  const text = `Verify your BorealisMark email address

Hi ${userName || 'there'},

Welcome to the BorealisMark Protocol ecosystem. To complete your registration and unlock full access, please visit this link:

${verifyLink}

This link will expire in 24 hours. If you didn't create this account, you can safely ignore this email.

— BorealisMark Protocol`;

  // If no API key, log the email instead of sending
  if (!process.env.RESEND_API_KEY) {
    logger.info('Verification email (NOT SENT — no RESEND_API_KEY)', {
      to: toEmail,
      verifyLink,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: 'Verify your BorealisMark email address',
      html,
      text,
    });

    if (result.error) {
      logger.error('Verification email send failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Verification email sent', { to: toEmail, id: result.data?.id });
    return true;
  } catch (err: any) {
    logger.error('Verification email error', { error: err.message, to: toEmail });
    return false;
  }
}

// ─── Subscription Expiry Reminder ──────────────────────────────────────────────

/**
 * Send a subscription expiry reminder email.
 * Called at 30 days, 7 days, and 1 day before expiry.
 */
export async function sendSubscriptionExpiryReminder(
  toEmail: string,
  userName: string,
  daysRemaining: number,
  planName: string,
  botCount: number,
  botLimit: number,
): Promise<boolean> {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://borealismark.com';
  const renewLink = `${frontendUrl}/dashboard.html?tab=billing`;

  const urgencyColor = daysRemaining <= 1 ? '#FF4444' : daysRemaining <= 7 ? '#FFA500' : '#D4A853';
  const urgencyText = daysRemaining <= 1
    ? 'Your subscription expires tomorrow!'
    : daysRemaining <= 7
    ? `Your subscription expires in ${daysRemaining} days`
    : `Your subscription expires in ${daysRemaining} days`;

  const botWarning = botCount > botLimit
    ? `<div style="background:rgba(255,68,68,0.1);border:1px solid rgba(255,68,68,0.3);border-radius:8px;padding:16px;margin:16px 0">
        <p style="color:#FF4444;font-weight:600;margin:0 0 8px 0">Bot Deactivation Warning</p>
        <p style="color:#A0A0A0;margin:0;font-size:14px">You currently have <strong style="color:#fff">${botCount} active bots</strong>. The Standard plan allows <strong style="color:#fff">${botLimit} bots</strong>. If you don't renew, your <strong style="color:#FF4444">${botCount - botLimit} least active bots will be automatically suspended</strong>. Their data and history will be preserved — you can reactivate them by upgrading again.</p>
      </div>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <h1 style="color:${urgencyColor}">${urgencyText}</h1>
      <p>Hi ${userName || 'there'},</p>
      <p>Your <strong style="color:#fff">${planName}</strong> subscription is expiring soon. Without renewal, your account will be downgraded to the Standard (free) tier.</p>
      ${botWarning}
      <p>Renew now to keep your bots running, your AP multiplier active, and your position on the leaderboard:</p>
      <a href="${renewLink}" class="btn">Renew Subscription</a>
      <div class="divider"></div>
      <p class="small">Pay with USDC on Hedera and save 5% on your renewal. Your BM Scores, badges, and audit history are always preserved regardless of plan.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol &mdash; AI Trust Certification on Hedera
    </div>
  </div>
</body>
</html>`;

  const text = `${urgencyText}\n\nHi ${userName || 'there'},\n\nYour ${planName} subscription is expiring soon. Without renewal, your account will be downgraded to Standard.${botCount > botLimit ? `\n\nWARNING: You have ${botCount} active bots but Standard only allows ${botLimit}. Your ${botCount - botLimit} least active bots will be suspended.` : ''}\n\nRenew here: ${renewLink}\n\n— BorealisMark Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Subscription expiry reminder (NOT SENT — no RESEND_API_KEY)', {
      to: toEmail, daysRemaining, planName, botCount, botLimit,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `${urgencyText} — BorealisMark ${planName}`,
      html,
      text,
    });

    if (result.error) {
      logger.error('Expiry reminder send failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Subscription expiry reminder sent', { to: toEmail, daysRemaining, planName });
    return true;
  } catch (err: any) {
    logger.error('Expiry reminder error', { error: err.message, to: toEmail });
    return false;
  }
}

/**
 * Send a downgrade notification email after bots have been suspended.
 */
export async function sendDowngradeNotificationEmail(
  toEmail: string,
  userName: string,
  previousPlan: string,
  suspendedBots: Array<{ name: string; id: string }>,
): Promise<boolean> {
  const frontendUrl = process.env.FRONTEND_URL ?? 'https://borealismark.com';
  const upgradeLink = `${frontendUrl}/dashboard.html?tab=billing`;

  const botListHtml = suspendedBots.length > 0
    ? `<div style="background:rgba(255,68,68,0.08);border:1px solid rgba(255,68,68,0.2);border-radius:8px;padding:16px;margin:16px 0">
        <p style="color:#FF4444;font-weight:600;margin:0 0 8px 0">Suspended Bots (${suspendedBots.length})</p>
        ${suspendedBots.map(b => `<p style="color:#A0A0A0;margin:4px 0;font-size:14px">&bull; ${b.name} <span style="color:#666;font-size:12px">(${b.id})</span></p>`).join('')}
        <p style="color:#888;margin:8px 0 0 0;font-size:13px">Their BM Scores, AP, and history are preserved. Upgrade to reactivate.</p>
      </div>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .small { font-size: 13px; color: #666; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark</div>
      <h1>Your subscription has expired</h1>
      <p>Hi ${userName || 'there'},</p>
      <p>Your <strong style="color:#fff">${previousPlan}</strong> subscription has expired and your account has been downgraded to the <strong style="color:#fff">Standard (free)</strong> tier.</p>
      ${botListHtml}
      <p>You can upgrade at any time to reactivate your bots and restore your full capabilities:</p>
      <a href="${upgradeLink}" class="btn">Upgrade Now</a>
      <div class="divider"></div>
      <p class="small">Your BM Scores, certifications, AP history, and badges are always preserved regardless of plan changes.</p>
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol &mdash; AI Trust Certification on Hedera
    </div>
  </div>
</body>
</html>`;

  const text = `Your ${previousPlan} subscription has expired.\n\nYour account has been downgraded to Standard (free).${suspendedBots.length > 0 ? `\n\nSuspended bots: ${suspendedBots.map(b => b.name).join(', ')}` : ''}\n\nUpgrade: ${upgradeLink}\n\n— BorealisMark Protocol`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Downgrade notification (NOT SENT — no RESEND_API_KEY)', {
      to: toEmail, previousPlan, suspendedCount: suspendedBots.length,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: `Subscription Expired — ${suspendedBots.length > 0 ? `${suspendedBots.length} bots suspended` : 'Account downgraded'}`,
      html,
      text,
    });

    if (result.error) {
      logger.error('Downgrade notification send failed', { error: result.error, to: toEmail });
      return false;
    }

    logger.info('Downgrade notification sent', { to: toEmail, suspendedCount: suspendedBots.length });
    return true;
  } catch (err: any) {
    logger.error('Downgrade notification error', { error: err.message, to: toEmail });
    return false;
  }
}

// ─── Order Email Templates ─────────────────────────────────────────────────────

interface OrderEmailData {
  orderId: string;
  listingTitle: string;
  totalCad: number;
  totalUsdc: number;
  buyerName: string;
  sellerName: string;
}

function orderEmailBase(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 40px 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 24px; }
    h1 { font-size: 22px; font-weight: 600; color: #FFFFFF; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 16px 0; }
    .highlight { color: #D4A853; font-weight: 600; }
    .btn { display: inline-block; background: #D4A853; color: #0C0D10; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px; margin: 8px 0 24px 0; }
    .divider { border-top: 1px solid #2A2B33; margin: 24px 0; }
    .detail { font-size: 14px; color: #888; margin: 4px 0; }
    .detail strong { color: #CCC; }
    .footer { text-align: center; padding: 24px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark Terminal</div>
      <h1>${title}</h1>
      ${body}
    </div>
    <div class="footer">
      &copy; ${new Date().getFullYear()} BorealisMark Protocol &mdash; The Trust-Gated Exchange
    </div>
  </div>
</body>
</html>`;
}

async function sendOrderEmail(to: string, subject: string, html: string, text: string): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    logger.info(`Order email (NOT SENT — no RESEND_API_KEY): ${subject}`, { to });
    return true;
  }
  try {
    const result = await getResend().emails.send({ from: FROM_ADDRESS, to: [to], subject, html, text });
    if (result.error) {
      logger.error('Order email send failed', { error: result.error, to });
      return false;
    }
    logger.info('Order email sent', { to, subject });
    return true;
  } catch (err: any) {
    logger.error('Order email error', { error: err.message, to });
    return false;
  }
}

/**
 * 1. Order Confirmation — sent to buyer after checkout
 */
export async function sendOrderConfirmationEmail(
  buyerEmail: string,
  data: OrderEmailData & { memo: string; treasuryAccountId: string },
): Promise<boolean> {
  const html = orderEmailBase('Order Confirmed', `
    <p>Hi ${data.buyerName},</p>
    <p>Your order has been placed on the Borealis Terminal marketplace.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Total:</strong> <span class="highlight">$${data.totalCad.toFixed(2)} CAD</span> (${data.totalUsdc.toFixed(6)} USDC)</p>
    <p class="detail"><strong>Seller:</strong> ${data.sellerName}</p>
    <div class="divider"></div>
    <p><strong style="color:#fff">Payment Instructions:</strong></p>
    <p>Send exactly <span class="highlight">${data.totalUsdc.toFixed(6)} USDC</span> to:</p>
    <p class="detail"><strong>Treasury:</strong> ${data.treasuryAccountId}</p>
    <p class="detail"><strong>Memo:</strong> ${data.memo}</p>
    <p>After sending, click "Verify Payment" in your order page. You have 30 minutes to complete the deposit.</p>
  `);
  const text = `Order Confirmed — ${data.listingTitle}\nOrder ID: ${data.orderId}\nTotal: $${data.totalCad.toFixed(2)} CAD (${data.totalUsdc.toFixed(6)} USDC)\nSend ${data.totalUsdc.toFixed(6)} USDC to ${data.treasuryAccountId} with memo: ${data.memo}`;
  return sendOrderEmail(buyerEmail, `Order Confirmed — ${data.listingTitle}`, html, text);
}

/**
 * 2. Seller Deposit Request — sent to seller when buyer deposits
 */
export async function sendSellerDepositRequestEmail(
  sellerEmail: string,
  data: OrderEmailData & { bondUsdc: number; memo: string; treasuryAccountId: string },
): Promise<boolean> {
  const html = orderEmailBase('Buyer Payment Received — Trust Bond Required', `
    <p>Hi ${data.sellerName},</p>
    <p>A buyer has deposited payment for your listing. To proceed, please deposit your 25% trust bond.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Sale Amount:</strong> <span class="highlight">$${data.totalCad.toFixed(2)} CAD</span></p>
    <p class="detail"><strong>Trust Bond:</strong> <span class="highlight">${data.bondUsdc.toFixed(6)} USDC</span> (25%)</p>
    <div class="divider"></div>
    <p>Send exactly <span class="highlight">${data.bondUsdc.toFixed(6)} USDC</span> to:</p>
    <p class="detail"><strong>Treasury:</strong> ${data.treasuryAccountId}</p>
    <p class="detail"><strong>Memo:</strong> ${data.memo}</p>
    <p>This bond will be returned to you after the buyer confirms delivery.</p>
  `);
  const text = `Trust Bond Required — Order ${data.orderId}\nItem: ${data.listingTitle}\nBond: ${data.bondUsdc.toFixed(6)} USDC to ${data.treasuryAccountId} with memo: ${data.memo}`;
  return sendOrderEmail(sellerEmail, `Trust Bond Required — ${data.listingTitle}`, html, text);
}

/**
 * 3. Escrow Active — sent to both parties when both deposits confirmed
 */
export async function sendEscrowActiveEmail(
  email: string,
  data: OrderEmailData & { isSeller: boolean },
): Promise<boolean> {
  const name = data.isSeller ? data.sellerName : data.buyerName;
  const action = data.isSeller
    ? 'Please ship the item and add tracking information in your seller dashboard.'
    : 'The seller has been notified to ship your item. You will receive tracking information soon.';
  const html = orderEmailBase('Escrow Active — Both Deposits Confirmed', `
    <p>Hi ${name},</p>
    <p>Both deposits have been confirmed. The escrow is now active for this transaction.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Total:</strong> <span class="highlight">$${data.totalCad.toFixed(2)} CAD</span></p>
    <div class="divider"></div>
    <p>${action}</p>
  `);
  const text = `Escrow Active — Order ${data.orderId}\nItem: ${data.listingTitle}\n${action}`;
  return sendOrderEmail(email, `Escrow Active — ${data.listingTitle}`, html, text);
}

/**
 * 4. Shipped — sent to buyer with tracking info
 */
export async function sendShippedEmail(
  buyerEmail: string,
  data: OrderEmailData & { carrier: string; trackingNumber: string },
): Promise<boolean> {
  const html = orderEmailBase('Your Order Has Shipped!', `
    <p>Hi ${data.buyerName},</p>
    <p>Your item has been shipped by ${data.sellerName}.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Carrier:</strong> ${data.carrier}</p>
    <p class="detail"><strong>Tracking:</strong> ${data.trackingNumber}</p>
    <div class="divider"></div>
    <p>Once you receive the item, please confirm delivery in your dashboard to release the escrow funds.</p>
  `);
  const text = `Shipped — Order ${data.orderId}\nItem: ${data.listingTitle}\nCarrier: ${data.carrier}\nTracking: ${data.trackingNumber}`;
  return sendOrderEmail(buyerEmail, `Shipped — ${data.listingTitle}`, html, text);
}

/**
 * 5. Delivery Confirmed — sent to seller
 */
export async function sendDeliveryConfirmedEmail(
  sellerEmail: string,
  data: OrderEmailData,
): Promise<boolean> {
  const html = orderEmailBase('Delivery Confirmed — Settlement Processing', `
    <p>Hi ${data.sellerName},</p>
    <p>The buyer has confirmed delivery of your item. Settlement is being processed.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    <p class="detail"><strong>Sale Amount:</strong> <span class="highlight">$${data.totalCad.toFixed(2)} CAD</span></p>
    <div class="divider"></div>
    <p>Your payment and trust bond return will be processed shortly.</p>
  `);
  const text = `Delivery Confirmed — Order ${data.orderId}\nSettlement processing for ${data.listingTitle}`;
  return sendOrderEmail(sellerEmail, `Delivery Confirmed — ${data.listingTitle}`, html, text);
}

/**
 * 6. Settlement Complete — sent to both parties
 */
export async function sendSettlementCompleteEmail(
  email: string,
  data: OrderEmailData & {
    isSeller: boolean;
    sellerPayout?: number;
    sellerBondReturned?: number;
    platformFee?: number;
    hederaTransactionId?: string;
  },
): Promise<boolean> {
  const name = data.isSeller ? data.sellerName : data.buyerName;
  const details = data.isSeller
    ? `<p class="detail"><strong>Payout:</strong> <span class="highlight">${data.sellerPayout?.toFixed(6)} USDC</span> (minus 2.5% platform fee)</p>
       <p class="detail"><strong>Bond Returned:</strong> ${data.sellerBondReturned?.toFixed(6)} USDC</p>
       <p class="detail"><strong>Platform Fee:</strong> ${data.platformFee?.toFixed(6)} USDC</p>`
    : `<p class="detail"><strong>Amount Paid:</strong> ${data.totalUsdc.toFixed(6)} USDC</p>`;
  const proof = data.hederaTransactionId
    ? `<p class="detail"><strong>Hedera Proof:</strong> ${data.hederaTransactionId}</p>`
    : '';
  const html = orderEmailBase('Transaction Complete', `
    <p>Hi ${name},</p>
    <p>The escrow has been settled and the transaction is complete.</p>
    <div class="divider"></div>
    <p class="detail"><strong>Order ID:</strong> ${data.orderId}</p>
    <p class="detail"><strong>Item:</strong> ${data.listingTitle}</p>
    ${details}
    ${proof}
    <div class="divider"></div>
    <p>Thank you for using the Borealis Terminal marketplace. All transactions are anchored on Hedera for immutable proof.</p>
  `);
  const text = `Transaction Complete — Order ${data.orderId}\nItem: ${data.listingTitle}`;
  return sendOrderEmail(email, `Transaction Complete — ${data.listingTitle}`, html, text);
}

// ─── Admin Notification Emails ──────────────────────────────────────────────

const ADMIN_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL ?? 'esimon.ng@gmail.com';

/**
 * Notify the platform admin when a new user registers.
 */
export async function sendAdminNewUserNotification(
  userEmail: string,
  userName: string,
  userId: string,
  tier: string = 'standard',
): Promise<boolean> {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });
  const dashboardUrl = 'https://borealismark-api.onrender.com/v1/admin/users';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; margin-bottom: 20px; }
    h1 { font-size: 20px; font-weight: 600; color: #4CAF50; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 12px 0; }
    .detail { font-size: 14px; color: #888; margin: 6px 0; }
    .detail strong { color: #CCC; }
    .highlight { color: #D4A853; font-weight: 600; }
    .divider { border-top: 1px solid #2A2B33; margin: 20px 0; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark Admin</div>
      <h1>New User Registered</h1>
      <p>A new user has just signed up on the BorealisMark platform.</p>
      <div class="divider"></div>
      <p class="detail"><strong>Name:</strong> <span class="highlight">${userName}</span></p>
      <p class="detail"><strong>Email:</strong> ${userEmail}</p>
      <p class="detail"><strong>Tier:</strong> ${tier}</p>
      <p class="detail"><strong>User ID:</strong> <span style="font-family:monospace;font-size:12px">${userId}</span></p>
      <p class="detail"><strong>Registered:</strong> ${timestamp}</p>
      <div class="divider"></div>
      <p class="detail" style="color:#666">View all users in the admin dashboard.</p>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} BorealisMark Protocol — Admin Notification</div>
  </div>
</body>
</html>`;

  const text = `New User Registered\n\nName: ${userName}\nEmail: ${userEmail}\nTier: ${tier}\nUser ID: ${userId}\nRegistered: ${timestamp}\n\nDashboard: ${dashboardUrl}`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Admin new user notification (NOT SENT — no RESEND_API_KEY)', {
      to: ADMIN_EMAIL, userEmail, userName, userId,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [ADMIN_EMAIL],
      subject: `New User: ${userName} (${userEmail})`,
      html,
      text,
    });
    if (result.error) {
      logger.error('Admin notification send failed', { error: result.error });
      return false;
    }
    logger.info('Admin new user notification sent', { to: ADMIN_EMAIL, userEmail });
    return true;
  } catch (err: any) {
    logger.error('Admin notification error', { error: err.message });
    return false;
  }
}

/**
 * Notify the platform admin when a user upgrades their subscription plan.
 */
export async function sendAdminSubscriptionNotification(
  userEmail: string,
  userName: string,
  userId: string,
  newTier: string,
  previousTier: string,
  method: string,
  planId?: string,
): Promise<boolean> {
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' });
  const tierColors: Record<string, string> = {
    standard: '#888',
    starter: '#4CAF50',
    pro: '#2196F3',
    business: '#9C27B0',
    elite: '#D4A853',
    enterprise: '#FF5722',
  };
  const color = tierColors[newTier.toLowerCase()] ?? '#D4A853';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0C0D10; color: #E0E0E0; }
    .container { max-width: 560px; margin: 40px auto; padding: 0 20px; }
    .card { background: #16171C; border: 1px solid #2A2B33; border-radius: 12px; padding: 32px; }
    .logo { color: #D4A853; font-size: 20px; font-weight: 700; margin-bottom: 20px; }
    h1 { font-size: 20px; font-weight: 600; color: ${color}; margin: 0 0 16px 0; }
    p { font-size: 15px; line-height: 1.6; color: #A0A0A0; margin: 0 0 12px 0; }
    .detail { font-size: 14px; color: #888; margin: 6px 0; }
    .detail strong { color: #CCC; }
    .highlight { color: #D4A853; font-weight: 600; }
    .tier-badge { display: inline-block; padding: 4px 12px; border-radius: 6px; font-weight: 600; font-size: 14px; }
    .divider { border-top: 1px solid #2A2B33; margin: 20px 0; }
    .footer { text-align: center; padding: 20px 0; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">BorealisMark Admin</div>
      <h1>Subscription ${previousTier === 'standard' ? 'Upgrade' : 'Change'}</h1>
      <p>A user has ${previousTier === 'standard' ? 'upgraded their subscription' : 'changed their plan'}.</p>
      <div class="divider"></div>
      <p class="detail"><strong>User:</strong> <span class="highlight">${userName}</span> (${userEmail})</p>
      <p class="detail"><strong>Plan Change:</strong> ${previousTier} &rarr; <span class="tier-badge" style="background:${color}22;color:${color};border:1px solid ${color}44">${newTier.toUpperCase()}</span></p>
      <p class="detail"><strong>Payment Method:</strong> ${method === 'stripe' ? 'Stripe (Card)' : 'USDC (Hedera)'}</p>
      ${planId ? `<p class="detail"><strong>Plan ID:</strong> <span style="font-family:monospace;font-size:12px">${planId}</span></p>` : ''}
      <p class="detail"><strong>User ID:</strong> <span style="font-family:monospace;font-size:12px">${userId}</span></p>
      <p class="detail"><strong>Time:</strong> ${timestamp}</p>
    </div>
    <div class="footer">&copy; ${new Date().getFullYear()} BorealisMark Protocol — Admin Notification</div>
  </div>
</body>
</html>`;

  const text = `Subscription ${previousTier === 'standard' ? 'Upgrade' : 'Change'}\n\nUser: ${userName} (${userEmail})\nPlan: ${previousTier} → ${newTier}\nMethod: ${method}\nTime: ${timestamp}`;

  if (!process.env.RESEND_API_KEY) {
    logger.info('Admin subscription notification (NOT SENT — no RESEND_API_KEY)', {
      to: ADMIN_EMAIL, userEmail, newTier, previousTier, method,
    });
    return true;
  }

  try {
    const result = await getResend().emails.send({
      from: FROM_ADDRESS,
      to: [ADMIN_EMAIL],
      subject: `${previousTier === 'standard' ? 'New' : ''} ${newTier.toUpperCase()} Sub: ${userName} (${method})`,
      html,
      text,
    });
    if (result.error) {
      logger.error('Admin subscription notification failed', { error: result.error });
      return false;
    }
    logger.info('Admin subscription notification sent', { to: ADMIN_EMAIL, userEmail, newTier });
    return true;
  } catch (err: any) {
    logger.error('Admin subscription notification error', { error: err.message });
    return false;
  }
}

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

const FROM_ADDRESS = 'BorealisMark <support@borealisprotocol.ai>';

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

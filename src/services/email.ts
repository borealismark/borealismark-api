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

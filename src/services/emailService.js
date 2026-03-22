'use strict';

const nodemailer = require('nodemailer');
const { Queue } = require('bullmq');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// BullMQ email queue
// ---------------------------------------------------------------------------
let emailQueue = null;

function getEmailQueue() {
  if (!emailQueue) {
    const redisConfig = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT, 10) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
    };
    emailQueue = new Queue('email', {
      connection: redisConfig,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return emailQueue;
}

// ---------------------------------------------------------------------------
// Nodemailer transporter – lazy singleton
// ---------------------------------------------------------------------------
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }
  return transporter;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const FROM_ADDRESS = `"${process.env.APP_NAME || 'InstaFlow'}" <${process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@instaflow.app'}>`;
const APP_URL = process.env.APP_URL || 'https://instaflow.app';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@instaflow.app';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@instaflow.app';

function baseStyles() {
  return `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f6f9; color: #1a1a2e; }
      .email-wrapper { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
      .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 36px 40px; text-align: center; }
      .header .logo { font-size: 28px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px; }
      .header .tagline { font-size: 13px; color: rgba(255,255,255,0.8); margin-top: 4px; }
      .body { padding: 40px; }
      .greeting { font-size: 22px; font-weight: 600; color: #1a1a2e; margin-bottom: 16px; }
      .text { font-size: 15px; line-height: 1.7; color: #4a5568; margin-bottom: 16px; }
      .btn { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff !important; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; margin: 8px 0; }
      .info-box { background: #f8f9ff; border-left: 4px solid #667eea; border-radius: 0 8px 8px 0; padding: 16px 20px; margin: 20px 0; }
      .info-box p { font-size: 14px; color: #4a5568; margin: 4px 0; }
      .info-box strong { color: #1a1a2e; }
      table.invoice { width: 100%; border-collapse: collapse; margin: 20px 0; }
      table.invoice th { background: #f8f9ff; padding: 10px 14px; font-size: 12px; font-weight: 600; text-transform: uppercase; color: #667eea; text-align: left; }
      table.invoice td { padding: 12px 14px; font-size: 14px; color: #4a5568; border-bottom: 1px solid #edf2f7; }
      table.invoice tr:last-child td { border-bottom: none; font-weight: 600; color: #1a1a2e; }
      .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 20px 0; }
      .stat-card { background: #f8f9ff; border-radius: 8px; padding: 16px; text-align: center; }
      .stat-card .value { font-size: 28px; font-weight: 700; color: #667eea; }
      .stat-card .label { font-size: 12px; color: #718096; margin-top: 4px; }
      .divider { height: 1px; background: #edf2f7; margin: 24px 0; }
      .footer { background: #f8f9ff; padding: 24px 40px; text-align: center; }
      .footer p { font-size: 12px; color: #a0aec0; line-height: 1.6; }
      .footer a { color: #667eea; text-decoration: none; }
      .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
      .badge-success { background: #c6f6d5; color: #276749; }
      .badge-warning { background: #fefcbf; color: #744210; }
      .badge-error { background: #fed7d7; color: #742a2a; }
      .alert-box { background: #fff5f5; border: 1px solid #feb2b2; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
      .alert-box p { font-size: 14px; color: #742a2a; }
    </style>
  `;
}

function emailWrapper(headerExtra, bodyContent) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${baseStyles()}
</head>
<body>
<div style="padding: 20px 0; background: #f4f6f9;">
  <div class="email-wrapper">
    <div class="header">
      <div class="logo">InstaFlow</div>
      <div class="tagline">Instagram Automation Platform</div>
      ${headerExtra || ''}
    </div>
    <div class="body">
      ${bodyContent}
    </div>
    <div class="footer">
      <p>
        &copy; ${new Date().getFullYear()} InstaFlow. All rights reserved.<br>
        <a href="${APP_URL}">Visit our website</a> &nbsp;|&nbsp;
        <a href="${APP_URL}/settings/notifications">Manage notifications</a> &nbsp;|&nbsp;
        <a href="mailto:${SUPPORT_EMAIL}">Contact support</a>
      </p>
      <p style="margin-top: 8px;">InstaFlow, 123 Tech Street, Bengaluru, Karnataka, India 560001</p>
    </div>
  </div>
</div>
</body>
</html>`;
}

function formatCurrency(amount, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Core send function with retry logic
// ---------------------------------------------------------------------------

/**
 * Send an email with up to 3 attempts (exponential backoff).
 * All emails are enqueued via BullMQ for reliability.
 *
 * @param {string}          to
 * @param {string}          subject
 * @param {string}          html
 * @param {string}          [text]
 * @param {object}          [attachments]  – nodemailer attachments array
 * @param {boolean}         [immediate]    – skip queue, send directly (for critical emails)
 */
async function sendEmail(to, subject, html, text, attachments = [], immediate = false) {
  const mailOptions = {
    from: FROM_ADDRESS,
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]+>/g, ''),
    attachments,
  };

  if (!immediate) {
    try {
      const queue = getEmailQueue();
      const job = await queue.add('send-email', mailOptions, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
      logger.info('[EmailService] Email queued', { to, subject, jobId: job.id });
      return { success: true, data: { queued: true, jobId: job.id }, error: null };
    } catch (queueErr) {
      logger.warn('[EmailService] Queue unavailable, falling back to direct send', {
        error: queueErr.message,
      });
      // fall through to direct send
    }
  }

  // Direct send with retry
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const info = await getTransporter().sendMail(mailOptions);
      logger.info('[EmailService] Email sent', {
        to,
        subject,
        messageId: info.messageId,
        attempt,
      });
      return { success: true, data: { messageId: info.messageId, attempt }, error: null };
    } catch (err) {
      lastError = err;
      logger.warn(`[EmailService] Send attempt ${attempt} failed`, { to, error: err.message });
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attempt * 2000)); // 2s, 4s
      }
    }
  }

  logger.error('[EmailService] All send attempts failed', { to, subject, error: lastError.message });
  return { success: false, data: null, error: lastError.message };
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

async function sendWelcomeEmail(user) {
  const subject = `Welcome to InstaFlow, ${user.name || user.email}!`;
  const verifyLink = `${APP_URL}/verify-email?token=${user.emailVerificationToken || ''}`;

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Welcome aboard, ${user.name || 'there'}! 🎉</p>
    <p class="text">We're thrilled to have you join InstaFlow — the all-in-one Instagram automation platform that helps you grow your audience on autopilot.</p>
    <p class="text">To get started, please verify your email address:</p>
    <div style="text-align:center; margin: 32px 0;">
      <a href="${verifyLink}" class="btn">Verify Email Address</a>
    </div>
    <p class="text">Once verified, you'll have access to:</p>
    <ul style="margin: 0 0 16px 20px; color: #4a5568; font-size: 15px; line-height: 2;">
      <li>Smart DM automation flows</li>
      <li>Campaign broadcasting</li>
      <li>Contact management & CRM</li>
      <li>Analytics &amp; insights</li>
    </ul>
    <div class="info-box">
      <p>If the button doesn't work, copy and paste this link:<br>
        <a href="${verifyLink}" style="color:#667eea; word-break: break-all;">${verifyLink}</a>
      </p>
    </div>
    <div class="divider"></div>
    <p class="text" style="font-size:13px; color:#718096;">
      This verification link expires in 24 hours. If you didn't create an InstaFlow account, please ignore this email.
    </p>
    `
  );

  return sendEmail(user.email, subject, html);
}

async function sendPasswordResetEmail(user, resetToken) {
  const subject = 'Reset your InstaFlow password';
  const resetLink = `${APP_URL}/reset-password?token=${resetToken}`;

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Password Reset Request</p>
    <p class="text">Hi ${user.name || 'there'},</p>
    <p class="text">We received a request to reset your InstaFlow account password. Click the button below to choose a new password:</p>
    <div style="text-align:center; margin: 32px 0;">
      <a href="${resetLink}" class="btn">Reset Password</a>
    </div>
    <div class="alert-box">
      <p><strong>Security notice:</strong> This link expires in <strong>1 hour</strong>. If you didn't request a password reset, please secure your account immediately by contacting <a href="mailto:${SUPPORT_EMAIL}" style="color:#742a2a;">${SUPPORT_EMAIL}</a>.</p>
    </div>
    <div class="info-box">
      <p>If the button doesn't work, copy and paste this link:<br>
        <a href="${resetLink}" style="color:#667eea; word-break: break-all;">${resetLink}</a>
      </p>
    </div>
    `
  );

  return sendEmail(user.email, subject, html, null, [], true); // immediate for security
}

async function sendEmailVerificationEmail(user, token) {
  const subject = 'Verify your InstaFlow email address';
  const verifyLink = `${APP_URL}/verify-email?token=${token}`;

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Confirm Your Email</p>
    <p class="text">Hi ${user.name || 'there'},</p>
    <p class="text">Please confirm your email address to activate your InstaFlow account.</p>
    <div style="text-align:center; margin: 32px 0;">
      <a href="${verifyLink}" class="btn">Confirm Email Address</a>
    </div>
    <div class="info-box">
      <p>If the button doesn't work, copy and paste this link:<br>
        <a href="${verifyLink}" style="color:#667eea; word-break: break-all;">${verifyLink}</a>
      </p>
      <p style="margin-top:8px;">This link expires in <strong>24 hours</strong>.</p>
    </div>
    `
  );

  return sendEmail(user.email, subject, html);
}

async function sendSubscriptionConfirmation(user, subscription, plan) {
  const subject = `Your ${plan.name} subscription is now active!`;

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Subscription Activated <span class="badge badge-success">Active</span></p>
    <p class="text">Hi ${user.name || 'there'},</p>
    <p class="text">Your <strong>${plan.name}</strong> subscription is now active. Here's a summary:</p>
    <div class="info-box">
      <p><strong>Plan:</strong> ${plan.name}</p>
      <p><strong>Billing Cycle:</strong> ${subscription.billingCycle || 'Monthly'}</p>
      <p><strong>Amount:</strong> ${formatCurrency(subscription.amount)}</p>
      <p><strong>Next Billing Date:</strong> ${formatDate(subscription.currentPeriodEnd)}</p>
      <p><strong>Subscription ID:</strong> ${subscription._id || subscription.id}</p>
    </div>
    <p class="text">You now have full access to all ${plan.name} features. Head to your dashboard to get started:</p>
    <div style="text-align:center; margin: 32px 0;">
      <a href="${APP_URL}/dashboard" class="btn">Go to Dashboard</a>
    </div>
    <div class="divider"></div>
    <p class="text" style="font-size:13px; color:#718096;">
      You can manage your subscription at any time from <a href="${APP_URL}/settings/billing" style="color:#667eea;">Settings → Billing</a>.
    </p>
    `
  );

  return sendEmail(user.email, subject, html);
}

async function sendPaymentSuccessEmail(user, payment, plan) {
  const subject = `Payment received – ${formatCurrency(payment.amount)}`;

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Payment Successful <span class="badge badge-success">Paid</span></p>
    <p class="text">Hi ${user.name || 'there'},</p>
    <p class="text">We've received your payment. Here's your receipt:</p>
    <table class="invoice">
      <thead>
        <tr>
          <th>Description</th>
          <th style="text-align:right;">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>${plan ? plan.name + ' Subscription' : (payment.description || 'Subscription')}</td>
          <td style="text-align:right;">${formatCurrency(payment.amount)}</td>
        </tr>
        ${payment.discountAmount ? `<tr><td>Discount</td><td style="text-align:right; color: #276749;">-${formatCurrency(payment.discountAmount)}</td></tr>` : ''}
        <tr>
          <td><strong>Total</strong></td>
          <td style="text-align:right;"><strong>${formatCurrency(payment.amount)}</strong></td>
        </tr>
      </tbody>
    </table>
    <div class="info-box">
      <p><strong>Payment ID:</strong> ${payment._id || payment.id}</p>
      <p><strong>Gateway:</strong> ${payment.gateway || 'Online'}</p>
      <p><strong>Transaction ID:</strong> ${payment.gatewayPaymentId || 'N/A'}</p>
      <p><strong>Date:</strong> ${formatDate(payment.paidAt || payment.createdAt)}</p>
    </div>
    <div style="text-align:center; margin: 32px 0;">
      <a href="${APP_URL}/settings/billing/invoices" class="btn">Download Invoice</a>
    </div>
    `
  );

  return sendEmail(user.email, subject, html);
}

async function sendPaymentFailedEmail(user, payment, reason) {
  const subject = 'Action required: Payment failed for your InstaFlow subscription';

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Payment Failed <span class="badge badge-error">Failed</span></p>
    <p class="text">Hi ${user.name || 'there'},</p>
    <div class="alert-box">
      <p><strong>We couldn't process your payment.</strong></p>
      <p style="margin-top:8px;">Reason: ${reason || 'Payment was declined'}</p>
    </div>
    <div class="info-box">
      <p><strong>Amount:</strong> ${formatCurrency(payment.amount)}</p>
      <p><strong>Date:</strong> ${formatDate(payment.createdAt)}</p>
      <p><strong>Attempt:</strong> ${payment.metadata && payment.metadata.failureCount ? `${payment.metadata.failureCount} of 3` : '1 of 3'}</p>
    </div>
    <p class="text">To avoid any interruption to your service, please update your payment method and retry:</p>
    <div style="text-align:center; margin: 32px 0;">
      <a href="${APP_URL}/settings/billing" class="btn">Update Payment Method</a>
    </div>
    <p class="text" style="font-size:13px; color:#718096;">
      We'll automatically retry the payment. If we're unable to process payment after 3 attempts, your account will be suspended.
    </p>
    `
  );

  return sendEmail(user.email, subject, html, null, [], true); // immediate
}

async function sendSubscriptionCanceledEmail(user, subscription) {
  const subject = 'Your InstaFlow subscription has been cancelled';

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Subscription Cancelled</p>
    <p class="text">Hi ${user.name || 'there'},</p>
    <p class="text">We've confirmed the cancellation of your InstaFlow subscription.</p>
    <div class="info-box">
      <p><strong>Subscription ID:</strong> ${subscription._id || subscription.id}</p>
      <p><strong>Cancelled On:</strong> ${formatDate(subscription.cancelledAt || new Date())}</p>
      <p><strong>Access Until:</strong> ${subscription.currentPeriodEnd ? formatDate(subscription.currentPeriodEnd) : 'Immediately'}</p>
    </div>
    <p class="text">Your account data will be retained for 30 days. You can resubscribe at any time to regain full access.</p>
    <div style="text-align:center; margin: 32px 0;">
      <a href="${APP_URL}/pricing" class="btn">Resubscribe</a>
    </div>
    <p class="text">We'd love to know how we can improve. Reply to this email with your feedback — we read every message.</p>
    `
  );

  return sendEmail(user.email, subject, html);
}

async function sendTrialEndingEmail(user, daysLeft) {
  const subject = `Your free trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Your Trial is Ending Soon <span class="badge badge-warning">${daysLeft} days left</span></p>
    <p class="text">Hi ${user.name || 'there'},</p>
    <p class="text">Your InstaFlow free trial ends in <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''}</strong>. Don't lose access to your automations!</p>
    <p class="text">Upgrade now to keep all your:</p>
    <ul style="margin: 0 0 16px 20px; color: #4a5568; font-size: 15px; line-height: 2;">
      <li>Active DM automation workflows</li>
      <li>Campaign contacts and broadcast lists</li>
      <li>Analytics history and reports</li>
      <li>Instagram account connections</li>
    </ul>
    <div style="text-align:center; margin: 32px 0;">
      <a href="${APP_URL}/pricing" class="btn">Upgrade Now</a>
    </div>
    <p class="text" style="font-size:13px; color:#718096;">
      Questions? Reply to this email or <a href="mailto:${SUPPORT_EMAIL}" style="color:#667eea;">contact our support team</a>.
    </p>
    `
  );

  return sendEmail(user.email, subject, html);
}

async function sendInvoiceEmail(user, payment, pdfBuffer) {
  const subject = `Invoice #${payment.invoiceNumber || payment._id} from InstaFlow`;
  const invoiceFilename = `invoice-${payment.invoiceNumber || payment._id}.pdf`;

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Your Invoice is Attached</p>
    <p class="text">Hi ${user.name || 'there'},</p>
    <p class="text">Please find attached your invoice for the payment of <strong>${formatCurrency(payment.amount)}</strong>.</p>
    <div class="info-box">
      <p><strong>Invoice #:</strong> ${payment.invoiceNumber || payment._id}</p>
      <p><strong>Date:</strong> ${formatDate(payment.paidAt || payment.createdAt)}</p>
      <p><strong>Amount:</strong> ${formatCurrency(payment.amount)}</p>
    </div>
    <p class="text">You can also view all your invoices from the billing dashboard:</p>
    <div style="text-align:center; margin: 32px 0;">
      <a href="${APP_URL}/settings/billing/invoices" class="btn">View All Invoices</a>
    </div>
    `
  );

  const attachments = pdfBuffer
    ? [{ filename: invoiceFilename, content: pdfBuffer, contentType: 'application/pdf' }]
    : [];

  return sendEmail(user.email, subject, html, null, attachments);
}

async function sendDailyReportEmail(user, stats) {
  const today = formatDate(new Date());
  const subject = `Your InstaFlow Daily Report – ${today}`;

  const html = emailWrapper(
    null,
    `
    <p class="greeting">Daily Performance Report</p>
    <p class="text">Hi ${user.name || 'there'},</p>
    <p class="text">Here's a summary of your Instagram automation performance for <strong>${today}</strong>:</p>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="value">${(stats.dmsSent || 0).toLocaleString()}</div>
        <div class="label">DMs Sent</div>
      </div>
      <div class="stat-card">
        <div class="value">${(stats.newContacts || 0).toLocaleString()}</div>
        <div class="label">New Contacts</div>
      </div>
      <div class="stat-card">
        <div class="value">${(stats.automationsTriggered || 0).toLocaleString()}</div>
        <div class="label">Automations Run</div>
      </div>
    </div>
    <div class="divider"></div>
    ${stats.topAutomation ? `
    <p class="text"><strong>Top Performing Automation:</strong></p>
    <div class="info-box">
      <p><strong>${stats.topAutomation.name}</strong></p>
      <p>${stats.topAutomation.triggerCount} triggers &nbsp;·&nbsp; ${stats.topAutomation.completionRate}% completion rate</p>
    </div>` : ''}
    <div style="text-align:center; margin: 32px 0;">
      <a href="${APP_URL}/dashboard/analytics" class="btn">View Full Analytics</a>
    </div>
    <p class="text" style="font-size:13px; color:#718096;">
      You can manage daily report preferences from <a href="${APP_URL}/settings/notifications" style="color:#667eea;">Notification Settings</a>.
    </p>
    `
  );

  return sendEmail(user.email, subject, html);
}

async function sendAdminAlertEmail(subject, message) {
  const html = emailWrapper(
    null,
    `
    <p class="greeting">Admin Alert</p>
    <div class="alert-box">
      <p><strong>${subject}</strong></p>
      <p style="margin-top:8px; white-space: pre-wrap;">${message}</p>
    </div>
    <div class="info-box">
      <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
      <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
    </div>
    `
  );

  return sendEmail(ADMIN_EMAIL, `[ALERT] ${subject}`, html, null, [], true);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendEmailVerificationEmail,
  sendSubscriptionConfirmation,
  sendPaymentSuccessEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCanceledEmail,
  sendTrialEndingEmail,
  sendInvoiceEmail,
  sendDailyReportEmail,
  sendAdminAlertEmail,
};

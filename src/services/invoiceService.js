'use strict';

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const mongoose = require('mongoose');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const INVOICE_BASE_DIR = path.join(
  process.env.PUBLIC_DIR || path.join(process.cwd(), 'public'),
  'invoices'
);
const APP_URL = process.env.APP_URL || 'https://instaflow.app';
const APP_NAME = process.env.APP_NAME || 'InstaFlow';
const COMPANY = {
  name: APP_NAME,
  address: '123 Tech Street, Koramangala',
  city: 'Bengaluru, Karnataka – 560034',
  country: 'India',
  gstin: process.env.COMPANY_GSTIN || 'GSTIN_NOT_SET',
  email: process.env.SUPPORT_EMAIL || 'billing@instaflow.app',
  website: APP_URL,
};
const GST_RATE = parseFloat(process.env.GST_RATE || '0.18'); // 18% GST

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getModels() {
  return {
    Payment: mongoose.model('Payment'),
    User: mongoose.model('User'),
  };
}

function ok(data) {
  return { success: true, data, error: null };
}

function fail(message, context, err) {
  logger.error(`[InvoiceService] ${context}: ${message}`, { stack: err && err.stack });
  return { success: false, data: null, error: message };
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// 1. generateInvoiceNumber
// ---------------------------------------------------------------------------

/**
 * Generate a unique sequential invoice number.
 * Format: INV-YYYY-XXXXXX  (e.g. INV-2024-000042)
 */
async function generateInvoiceNumber(userId) {
  try {
    const { Payment } = getModels();
    const year = new Date().getFullYear();
    const prefix = `INV-${year}-`;

    // Count invoices issued this year to generate sequential number
    const count = await Payment.countDocuments({
      invoiceNumber: { $regex: `^${prefix}` },
    });

    const sequence = String(count + 1).padStart(6, '0');
    const invoiceNumber = `${prefix}${sequence}`;

    return ok(invoiceNumber);
  } catch (err) {
    return fail(err.message, 'generateInvoiceNumber', err);
  }
}

// ---------------------------------------------------------------------------
// 2. generateInvoicePDF
// ---------------------------------------------------------------------------

/**
 * Generate a professional invoice PDF using PDFKit.
 * Returns a Buffer containing the PDF.
 *
 * @param {object} payment – Payment document (populated)
 * @param {object} user    – User document
 * @param {object} plan    – Plan document
 * @returns {{ success, data: Buffer, error }}
 */
async function generateInvoicePDF(payment, user, plan) {
  return new Promise((resolve) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Invoice ${payment.invoiceNumber || payment._id}`,
          Author: APP_NAME,
          Subject: 'Payment Invoice',
        },
      });

      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => resolve(ok(Buffer.concat(buffers))));
      doc.on('error', (err) => resolve(fail(err.message, 'generateInvoicePDF', err)));

      // ---- Palette ----
      const PRIMARY = '#667eea';
      const DARK = '#1a1a2e';
      const MUTED = '#718096';
      const LIGHT_BG = '#f8f9ff';
      const BORDER = '#e2e8f0';
      const SUCCESS = '#276749';

      const PAGE_WIDTH = doc.page.width - 100; // accounting for margins

      // ---------------------------------------------------------------
      // HEADER BAND
      // ---------------------------------------------------------------
      doc.rect(0, 0, doc.page.width, 90).fill(PRIMARY);

      // Logo text
      doc
        .fillColor('#ffffff')
        .fontSize(26)
        .font('Helvetica-Bold')
        .text(APP_NAME, 50, 28);

      doc
        .fillColor('rgba(255,255,255,0.7)')
        .fontSize(10)
        .font('Helvetica')
        .text('Instagram Automation Platform', 50, 58);

      // INVOICE label (right side of header)
      doc
        .fillColor('#ffffff')
        .fontSize(32)
        .font('Helvetica-Bold')
        .text('INVOICE', 0, 28, { align: 'right' });

      // ---------------------------------------------------------------
      // INVOICE META (below header)
      // ---------------------------------------------------------------
      const metaY = 110;
      doc
        .fillColor(PRIMARY)
        .fontSize(10)
        .font('Helvetica-Bold')
        .text('INVOICE NUMBER', 50, metaY);
      doc
        .fillColor(DARK)
        .fontSize(12)
        .font('Helvetica-Bold')
        .text(payment.invoiceNumber || String(payment._id), 50, metaY + 14);

      doc
        .fillColor(PRIMARY)
        .fontSize(10)
        .font('Helvetica-Bold')
        .text('DATE', 220, metaY);
      doc
        .fillColor(DARK)
        .fontSize(12)
        .font('Helvetica')
        .text(formatDate(payment.paidAt || payment.createdAt), 220, metaY + 14);

      doc
        .fillColor(PRIMARY)
        .fontSize(10)
        .font('Helvetica-Bold')
        .text('STATUS', 390, metaY);

      const status = payment.status === 'completed' ? 'PAID' : payment.status.toUpperCase();
      const statusColor = payment.status === 'completed' ? SUCCESS : '#744210';
      doc.rect(390, metaY + 10, 70, 20).fill(payment.status === 'completed' ? '#c6f6d5' : '#fefcbf');
      doc
        .fillColor(statusColor)
        .fontSize(10)
        .font('Helvetica-Bold')
        .text(status, 390, metaY + 14, { width: 70, align: 'center' });

      // Divider
      doc
        .moveTo(50, metaY + 44)
        .lineTo(50 + PAGE_WIDTH, metaY + 44)
        .strokeColor(BORDER)
        .lineWidth(1)
        .stroke();

      // ---------------------------------------------------------------
      // BILLING ADDRESSES – FROM / TO
      // ---------------------------------------------------------------
      const addrY = metaY + 60;
      const colWidth = PAGE_WIDTH / 2 - 20;

      // FROM (Company)
      doc.fillColor(PRIMARY).fontSize(9).font('Helvetica-Bold').text('FROM', 50, addrY);
      doc.fillColor(DARK).fontSize(13).font('Helvetica-Bold').text(COMPANY.name, 50, addrY + 14);
      doc
        .fillColor(MUTED)
        .fontSize(10)
        .font('Helvetica')
        .text(
          `${COMPANY.address}\n${COMPANY.city}\n${COMPANY.country}\nGSTIN: ${COMPANY.gstin}\n${COMPANY.email}`,
          50,
          addrY + 30,
          { width: colWidth, lineGap: 2 }
        );

      // TO (Customer)
      const toX = 50 + colWidth + 40;
      doc.fillColor(PRIMARY).fontSize(9).font('Helvetica-Bold').text('BILL TO', toX, addrY);
      doc.fillColor(DARK).fontSize(13).font('Helvetica-Bold').text(user.name || user.email, toX, addrY + 14);
      doc
        .fillColor(MUTED)
        .fontSize(10)
        .font('Helvetica')
        .text(
          [
            user.email,
            user.phone || '',
            user.address ? user.address : '',
            user.city ? user.city : '',
            user.gstin ? `GSTIN: ${user.gstin}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          toX,
          addrY + 30,
          { width: colWidth, lineGap: 2 }
        );

      // ---------------------------------------------------------------
      // LINE ITEMS TABLE
      // ---------------------------------------------------------------
      const tableY = addrY + 130;

      // Table header background
      doc.rect(50, tableY, PAGE_WIDTH, 26).fill(LIGHT_BG);

      // Column headers
      const colX = { desc: 50, period: 260, qty: 360, unit: 420, total: 480 };
      doc.fillColor(PRIMARY).fontSize(9).font('Helvetica-Bold');
      doc.text('DESCRIPTION', colX.desc + 6, tableY + 9);
      doc.text('BILLING PERIOD', colX.period, tableY + 9);
      doc.text('QTY', colX.qty, tableY + 9, { width: 50, align: 'right' });
      doc.text('UNIT PRICE', colX.unit, tableY + 9, { width: 55, align: 'right' });
      doc.text('AMOUNT', colX.total, tableY + 9, { width: 65, align: 'right' });

      // Row
      const rowY = tableY + 30;
      doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold');
      doc.text(plan ? `${plan.name} Subscription` : (payment.description || 'Subscription'), colX.desc + 6, rowY);
      doc.fillColor(MUTED).fontSize(9).font('Helvetica');
      if (plan && plan.features) {
        const featureText = Array.isArray(plan.features)
          ? plan.features.slice(0, 3).join(', ')
          : String(plan.features);
        doc.text(featureText, colX.desc + 6, rowY + 14, { width: colWidth - 10 });
      }

      const billingStart = payment.billingPeriodStart || payment.createdAt;
      const billingEnd = payment.billingPeriodEnd || new Date();
      doc.fillColor(MUTED).fontSize(9).font('Helvetica');
      doc.text(`${formatDate(billingStart)} –\n${formatDate(billingEnd)}`, colX.period, rowY, {
        width: 90,
        lineGap: 1,
      });

      doc.fillColor(DARK).fontSize(10).font('Helvetica');
      doc.text('1', colX.qty, rowY, { width: 50, align: 'right' });

      // Calculate base amount (before GST)
      const totalWithGst = payment.amount;
      const baseAmount = totalWithGst / (1 + GST_RATE);
      const gstAmount = totalWithGst - baseAmount;
      const discountAmount = payment.discountAmount || 0;

      doc.text(formatCurrency(baseAmount + discountAmount), colX.unit, rowY, { width: 55, align: 'right' });
      doc.text(formatCurrency(baseAmount + discountAmount), colX.total, rowY, { width: 65, align: 'right' });

      // Row divider
      const dividerY = rowY + 50;
      doc.moveTo(50, dividerY).lineTo(50 + PAGE_WIDTH, dividerY).strokeColor(BORDER).lineWidth(0.5).stroke();

      // ---------------------------------------------------------------
      // TOTALS SECTION
      // ---------------------------------------------------------------
      const totalsX = 360;
      let totalsY = dividerY + 16;
      const labelW = 120;
      const valW = 65;

      const addTotalRow = (label, value, bold = false, color = DARK) => {
        doc.fillColor(MUTED).fontSize(10).font('Helvetica').text(label, totalsX, totalsY, { width: labelW });
        doc
          .fillColor(color)
          .fontSize(10)
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .text(value, totalsX + labelW, totalsY, { width: valW, align: 'right' });
        totalsY += 18;
      };

      addTotalRow('Subtotal', formatCurrency(baseAmount + discountAmount));
      if (discountAmount > 0) {
        addTotalRow('Discount', `-${formatCurrency(discountAmount)}`, false, SUCCESS);
      }
      addTotalRow(`GST (${(GST_RATE * 100).toFixed(0)}%)`, formatCurrency(gstAmount));

      // Total divider
      doc
        .moveTo(totalsX, totalsY + 2)
        .lineTo(totalsX + labelW + valW, totalsY + 2)
        .strokeColor(BORDER)
        .lineWidth(0.5)
        .stroke();
      totalsY += 10;

      addTotalRow('TOTAL', formatCurrency(totalWithGst), true, PRIMARY);

      // ---------------------------------------------------------------
      // PAYMENT DETAILS BOX
      // ---------------------------------------------------------------
      const payBoxY = totalsY + 24;
      doc.rect(50, payBoxY, PAGE_WIDTH, 60).fill(LIGHT_BG).stroke(BORDER);
      doc.fillColor(PRIMARY).fontSize(9).font('Helvetica-Bold').text('PAYMENT DETAILS', 62, payBoxY + 10);

      const payDetails = [
        ['Gateway', payment.gateway || 'Online'],
        ['Transaction ID', payment.gatewayPaymentId || 'N/A'],
        ['Order ID', payment.gatewayOrderId || 'N/A'],
        ['Payment Method', payment.paymentMethod || 'Online Payment'],
      ];

      let pdX = 62;
      payDetails.forEach(([label, value]) => {
        doc.fillColor(MUTED).fontSize(8).font('Helvetica').text(label, pdX, payBoxY + 24);
        doc.fillColor(DARK).fontSize(9).font('Helvetica-Bold').text(value, pdX, payBoxY + 36, { width: 100 });
        pdX += 120;
      });

      // ---------------------------------------------------------------
      // FOOTER
      // ---------------------------------------------------------------
      const footerY = doc.page.height - 80;
      doc.moveTo(50, footerY - 10).lineTo(50 + PAGE_WIDTH, footerY - 10).strokeColor(BORDER).lineWidth(0.5).stroke();

      doc
        .fillColor(MUTED)
        .fontSize(9)
        .font('Helvetica')
        .text(
          `Thank you for your business! For any billing questions, contact ${COMPANY.email} | ${COMPANY.website}`,
          50,
          footerY,
          { width: PAGE_WIDTH, align: 'center' }
        );
      doc
        .fillColor(MUTED)
        .fontSize(8)
        .text(
          `This is a computer-generated invoice and does not require a physical signature.`,
          50,
          footerY + 16,
          { width: PAGE_WIDTH, align: 'center' }
        );

      doc.end();
    } catch (err) {
      resolve(fail(err.message, 'generateInvoicePDF', err));
    }
  });
}

// ---------------------------------------------------------------------------
// 3. saveInvoice
// ---------------------------------------------------------------------------

/**
 * Save PDF buffer to /public/invoices/[year]/[month]/.
 * @param {object} payment   – Payment document with _id and invoiceNumber
 * @param {Buffer} pdfBuffer – PDF buffer from generateInvoicePDF
 * @returns {{ success, data: { filePath, relativePath }, error }}
 */
async function saveInvoice(payment, pdfBuffer) {
  try {
    const date = new Date(payment.paidAt || payment.createdAt || Date.now());
    const year = date.getFullYear().toString();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    const dirPath = path.join(INVOICE_BASE_DIR, year, month);
    ensureDir(dirPath);

    const filename = `invoice-${payment.invoiceNumber || payment._id}.pdf`;
    const filePath = path.join(dirPath, filename);
    fs.writeFileSync(filePath, pdfBuffer);

    const relativePath = path.join('invoices', year, month, filename);

    logger.info('[InvoiceService] Invoice saved', { filePath, paymentId: payment._id });
    return ok({ filePath, relativePath });
  } catch (err) {
    return fail(err.message, 'saveInvoice', err);
  }
}

// ---------------------------------------------------------------------------
// 4. getInvoiceUrl
// ---------------------------------------------------------------------------

/**
 * Return the public URL for a saved invoice.
 * @param {object} payment – Payment document
 */
function getInvoiceUrl(payment) {
  try {
    if (!payment) return fail('Payment is required', 'getInvoiceUrl');

    const date = new Date(payment.paidAt || payment.createdAt || Date.now());
    const year = date.getFullYear().toString();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const filename = `invoice-${payment.invoiceNumber || payment._id}.pdf`;
    const url = `${APP_URL}/invoices/${year}/${month}/${filename}`;
    return ok(url);
  } catch (err) {
    return fail(err.message, 'getInvoiceUrl', err);
  }
}

// ---------------------------------------------------------------------------
// 5. listUserInvoices
// ---------------------------------------------------------------------------

/**
 * Return a paginated list of invoices (payments with invoiceNumber) for a user.
 * @param {string} userId
 * @param {number} page  – 1-based
 * @param {number} limit
 */
async function listUserInvoices(userId, page = 1, limit = 10) {
  const { Payment } = getModels();
  try {
    const skip = (Math.max(1, page) - 1) * limit;

    const [invoices, total] = await Promise.all([
      Payment.find({
        user: userId,
        status: 'completed',
        invoiceNumber: { $exists: true, $ne: null },
      })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('subscription', 'billingCycle')
        .lean(),
      Payment.countDocuments({
        user: userId,
        status: 'completed',
        invoiceNumber: { $exists: true, $ne: null },
      }),
    ]);

    // Attach public URLs
    const invoicesWithUrls = invoices.map((inv) => {
      const urlResult = getInvoiceUrl(inv);
      return { ...inv, invoiceUrl: urlResult.success ? urlResult.data : null };
    });

    return ok({
      invoices: invoicesWithUrls,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    });
  } catch (err) {
    return fail(err.message, 'listUserInvoices', err);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  generateInvoiceNumber,
  generateInvoicePDF,
  saveInvoice,
  getInvoiceUrl,
  listUserInvoices,
};

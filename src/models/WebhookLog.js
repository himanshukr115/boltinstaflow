'use strict';

const mongoose = require('mongoose');

const webhookLogSchema = new mongoose.Schema(
  {
    source: { type: String, required: true, trim: true },
    event: { type: String, default: '' },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    headers: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['received', 'processed', 'failed'], default: 'received' },
    error: { type: String, default: '' },
    receivedAt: { type: Date, default: Date.now, index: true },
    processedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WebhookLog', webhookLogSchema);

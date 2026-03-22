'use strict';

const mongoose = require('mongoose');

const linkPageClickSchema = new mongoose.Schema(
  {
    linkPageId: { type: mongoose.Schema.Types.ObjectId, ref: 'LinkPage', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    linkUrl: { type: String, default: '' },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    referrer: { type: String, default: '' },
    country: { type: String, default: '' },
    clickedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('LinkPageClick', linkPageClickSchema);

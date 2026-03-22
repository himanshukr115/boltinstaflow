'use strict';

const mongoose = require('mongoose');

const appSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed },
    description: { type: String, default: '' },
    isPublic: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppSettings', appSettingsSchema);

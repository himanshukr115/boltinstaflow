'use strict';

const path = require('path');
const { Readable } = require('stream');
const multer = require('multer');

const Contact = require('../models/Contact');
const Segment = require('../models/Segment');
const AuditLog = require('../models/AuditLog');
const logger = require('../config/logger');

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Multer config for CSV import uploads (memory storage for streaming parse)
// ---------------------------------------------------------------------------
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      return cb(null, true);
    }
    cb(new Error('Only CSV files are allowed.'));
  },
});

// ---------------------------------------------------------------------------
// Minimal CSV row parser (avoids external dependencies for simple flat CSVs)
// Handles double-quoted fields with commas inside.
// ---------------------------------------------------------------------------
function parseCsvRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvRow(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvRow(line);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = values[i] !== undefined ? values[i] : '';
    });
    return obj;
  });
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// index  (GET /dashboard/contacts)
// ---------------------------------------------------------------------------
const index = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * PAGE_SIZE;
    const search = req.query.search ? req.query.search.trim() : '';
    const tagFilter = req.query.tag ? req.query.tag.trim() : '';

    const query = { userId: req.user._id, isDeleted: false };
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    if (tagFilter) {
      query.tags = tagFilter;
    }

    const [contacts, total] = await Promise.all([
      Contact.find(query).sort({ updatedAt: -1 }).skip(skip).limit(PAGE_SIZE).lean(),
      Contact.countDocuments(query),
    ]);

    return res.render('contacts/index', {
      title: 'Contacts',
      contacts,
      currentPage: page,
      totalPages: Math.ceil(total / PAGE_SIZE),
      total,
      search,
      tagFilter,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Contact index error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// show  (GET /dashboard/contacts/:id)
// ---------------------------------------------------------------------------
const show = async (req, res, next) => {
  try {
    const contact = await Contact.findOne({
      _id: req.params.id,
      userId: req.user._id,
      isDeleted: false,
    }).lean();

    if (!contact) {
      req.flash('error', 'Contact not found.');
      return res.redirect('/dashboard/contacts');
    }

    return res.render('contacts/show', {
      title: contact.fullName || contact.username || 'Contact',
      contact,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// update  (PUT /dashboard/contacts/:id)  → JSON
// ---------------------------------------------------------------------------
const update = async (req, res, next) => {
  try {
    const { tags, customFields, notes } = req.body;

    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isDeleted: false },
      {
        ...(Array.isArray(tags) && { tags }),
        ...(customFields && typeof customFields === 'object' && { customFields }),
        ...(typeof notes === 'string' && { notes: notes.substring(0, 2000) }),
        updatedAt: new Date(),
      },
      { new: true },
    );

    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found.' });
    }

    return res.json({ success: true, contact });
  } catch (err) {
    logger.error('Contact update error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// destroy  (DELETE /dashboard/contacts/:id)  → JSON
// ---------------------------------------------------------------------------
const destroy = async (req, res, next) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isDeleted: false },
      { isDeleted: true, deletedAt: new Date() },
      { new: true },
    );

    if (!contact) {
      return res.status(404).json({ success: false, message: 'Contact not found.' });
    }

    return res.json({ success: true, message: 'Contact deleted.' });
  } catch (err) {
    logger.error('Contact destroy error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// import  (POST /dashboard/contacts/import)  – multipart CSV
// ---------------------------------------------------------------------------
const importContacts = [
  csvUpload.single('csv'),
  async (req, res, next) => {
    if (!req.file) {
      req.flash('error', 'Please upload a CSV file.');
      return res.redirect('/dashboard/contacts');
    }

    try {
      const { headers, rows } = parseCsvBuffer(req.file.buffer);

      const REQUIRED = ['username'];
      const missing = REQUIRED.filter((h) => !headers.includes(h));
      if (missing.length > 0) {
        req.flash('error', `CSV is missing required columns: ${missing.join(', ')}`);
        return res.redirect('/dashboard/contacts');
      }

      let imported = 0;
      let skipped = 0;

      for (const row of rows) {
        const username = (row.username || '').trim();
        if (!username) { skipped++; continue; }

        try {
          await Contact.findOneAndUpdate(
            { userId: req.user._id, username },
            {
              userId: req.user._id,
              username,
              fullName: row.full_name || row.name || '',
              email: row.email || '',
              phone: row.phone || '',
              tags: row.tags ? row.tags.split(';').map((t) => t.trim()).filter(Boolean) : [],
              isDeleted: false,
              $setOnInsert: { createdAt: new Date() },
              updatedAt: new Date(),
            },
            { upsert: true, new: true },
          );
          imported++;
        } catch (rowErr) {
          logger.warn('CSV import row error', { error: rowErr.message, username });
          skipped++;
        }
      }

      await AuditLog.create({
        userId: req.user._id,
        action: 'contacts.imported',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { imported, skipped, filename: req.file.originalname },
      });

      req.flash('success', `Import complete: ${imported} contacts imported, ${skipped} skipped.`);
      return res.redirect('/dashboard/contacts');
    } catch (err) {
      logger.error('Contact import error', { error: err.message });
      req.flash('error', 'Import failed. Please check your CSV file and try again.');
      return res.redirect('/dashboard/contacts');
    }
  },
];

// ---------------------------------------------------------------------------
// export  (GET /dashboard/contacts/export)
// ---------------------------------------------------------------------------
const exportContacts = async (req, res, next) => {
  try {
    const search = req.query.search ? req.query.search.trim() : '';
    const tagFilter = req.query.tag ? req.query.tag.trim() : '';

    const query = { userId: req.user._id, isDeleted: false };
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }
    if (tagFilter) query.tags = tagFilter;

    const contacts = await Contact.find(query).sort({ createdAt: -1 }).lean();

    const escapeCell = (val) => {
      const str = val == null ? '' : String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const COLS = ['username', 'fullName', 'email', 'phone', 'tags', 'notes', 'createdAt'];
    const header = COLS.join(',');
    const csvRows = contacts.map((c) =>
      COLS.map((col) => {
        if (col === 'tags') return escapeCell((c.tags || []).join(';'));
        if (col === 'createdAt') return escapeCell(c.createdAt ? c.createdAt.toISOString() : '');
        return escapeCell(c[col]);
      }).join(','),
    );

    const csvContent = [header, ...csvRows].join('\r\n');
    const filename = `contacts-export-${Date.now()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(csvContent, 'utf8'));
    return res.end(csvContent, 'utf8');
  } catch (err) {
    logger.error('Contact export error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// bulkTag  (POST /dashboard/contacts/bulk-tag)  → JSON
// ---------------------------------------------------------------------------
const bulkTag = async (req, res, next) => {
  const { contactIds, tags, action } = req.body;

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ success: false, message: 'No contacts selected.' });
  }
  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ success: false, message: 'No tags provided.' });
  }
  if (!['add', 'remove'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Action must be "add" or "remove".' });
  }

  try {
    const updateOp =
      action === 'add'
        ? { $addToSet: { tags: { $each: tags } } }
        : { $pullAll: { tags } };

    const result = await Contact.updateMany(
      { _id: { $in: contactIds }, userId: req.user._id, isDeleted: false },
      updateOp,
    );

    return res.json({ success: true, modified: result.modifiedCount });
  } catch (err) {
    logger.error('Bulk tag error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// segments  (GET /dashboard/contacts/segments)
// ---------------------------------------------------------------------------
const segments = async (req, res, next) => {
  try {
    const segs = await Segment.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    return res.render('contacts/segments', {
      title: 'Segments',
      segments: segs,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// createSegment  (POST /dashboard/contacts/segments)  → JSON
// ---------------------------------------------------------------------------
const createSegment = async (req, res, next) => {
  const { name, filters } = req.body;

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ success: false, message: 'Segment name is required.' });
  }
  if (!filters || typeof filters !== 'object') {
    return res.status(400).json({ success: false, message: 'Filters are required.' });
  }

  try {
    const segment = await Segment.create({
      userId: req.user._id,
      name: name.trim().substring(0, 100),
      filters,
    });

    return res.status(201).json({ success: true, segment });
  } catch (err) {
    logger.error('Create segment error', { error: err.message });
    return next(err);
  }
};

module.exports = {
  index,
  show,
  update,
  destroy,
  import: importContacts,
  export: exportContacts,
  bulkTag,
  segments,
  createSegment,
};

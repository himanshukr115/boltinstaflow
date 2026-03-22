'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const ALLOWED_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp']);

const BASE_UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_BASE_DIR || path.join(process.cwd(), 'public', 'uploads')
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return a zero-padded month string (01-12).
 * @returns {string}
 */
function paddedMonth() {
  return String(new Date().getMonth() + 1).padStart(2, '0');
}

/**
 * Return the current four-digit year string.
 * @returns {string}
 */
function currentYear() {
  return String(new Date().getFullYear());
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 * @param {string} dirPath
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Generate a collision-resistant filename while preserving the original
 * extension.
 * @param {string} originalName - The original filename from the client.
 * @returns {string}
 */
function generateFilename(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return `${Date.now()}-${uuidv4()}${ext}`;
}

// ---------------------------------------------------------------------------
// File filter
// ---------------------------------------------------------------------------

/**
 * Multer file filter that accepts only allowed image MIME types and extensions.
 * @type {multer.Options['fileFilter']}
 */
function imageFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (!ALLOWED_MIME_TYPES.has(file.mimetype) || !ALLOWED_EXTENSIONS.has(ext)) {
    return cb(
      Object.assign(
        new Error(
          `Invalid file type "${file.mimetype}". Only JPEG, PNG, GIF, and WebP images are allowed.`
        ),
        { statusCode: 400 }
      ),
      false
    );
  }

  cb(null, true);
}

// ---------------------------------------------------------------------------
// Disk storage – organised by year/month
// ---------------------------------------------------------------------------

const diskStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dest = path.join(BASE_UPLOAD_DIR, currentYear(), paddedMonth());
    try {
      ensureDir(dest);
      cb(null, dest);
    } catch (err) {
      cb(err);
    }
  },

  filename(req, file, cb) {
    cb(null, generateFilename(file.originalname));
  },
});

// ---------------------------------------------------------------------------
// Memory storage – for pipelines that process the buffer before saving
// ---------------------------------------------------------------------------

const memStorage = multer.memoryStorage();

// ---------------------------------------------------------------------------
// Multer instances
// ---------------------------------------------------------------------------

/** Disk-based upload handler (single, array, fields). */
const upload = multer({
  storage: diskStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 10,         // Safety ceiling – individual routes may impose stricter limits
    fields: 20,
    fieldNameSize: 200,
    fieldSize: 1 * 1024 * 1024, // 1 MB per text field
  },
});

/** Memory-based upload handler – returned buffer is available on req.file.buffer. */
const uploadMemory = multer({
  storage: memStorage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 10,
    fields: 20,
    fieldNameSize: 200,
    fieldSize: 1 * 1024 * 1024,
  },
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  /**
   * Disk-based multer instance.
   * Usage:
   *   upload.single('avatar')
   *   upload.array('photos', 5)
   *   upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'gallery', maxCount: 4 }])
   */
  upload,

  /**
   * Memory-based multer instance – file contents available in req.file.buffer.
   * Usage:
   *   uploadMemory.single('image')
   */
  uploadMemory,

  // Exposed for unit-testing and custom route overrides
  MAX_FILE_SIZE_BYTES,
  ALLOWED_MIME_TYPES,
  BASE_UPLOAD_DIR,
  imageFileFilter,
};

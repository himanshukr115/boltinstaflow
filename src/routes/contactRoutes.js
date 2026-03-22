'use strict';

/**
 * Contact routes — /dashboard/contacts/*
 *
 * All routes require authentication and an active subscription.
 * Static path segments (segments, bulk-tag, import, export) must be
 * declared before the dynamic /:id segment to prevent routing conflicts.
 */

const express = require('express');
const router  = express.Router();

const contactController                             = require('../controllers/contactController');
const { requireAuth, requireActiveSubscription }    = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Global guards
// ---------------------------------------------------------------------------
router.use(requireAuth);
router.use(requireActiveSubscription);

// ---------------------------------------------------------------------------
// Segment management — must come before /:id routes
// ---------------------------------------------------------------------------

/** GET /dashboard/contacts/segments — list saved segments */
router.get('/segments', contactController.segments);

/** POST /dashboard/contacts/segments — create a new segment (returns JSON) */
router.post('/segments', contactController.createSegment);

// ---------------------------------------------------------------------------
// Bulk operations — must come before /:id routes
// ---------------------------------------------------------------------------

/** POST /dashboard/contacts/bulk-tag — add/remove tags from multiple contacts (returns JSON) */
router.post('/bulk-tag', contactController.bulkTag);

// ---------------------------------------------------------------------------
// Import / export — must come before /:id routes
// contactController.import is an array: [multerMiddleware, asyncHandler]
// ---------------------------------------------------------------------------

/** POST /dashboard/contacts/import — bulk import contacts from CSV */
router.post('/import', ...contactController.import);

/** GET /dashboard/contacts/export — export contacts as CSV download */
router.get('/export', contactController.export);

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** GET /dashboard/contacts — paginated contact list with search */
router.get('/', contactController.index);

/** GET /dashboard/contacts/:id — contact detail page */
router.get('/:id', contactController.show);

/** PUT /dashboard/contacts/:id — update contact fields (tags, notes, customFields) — returns JSON */
router.put('/:id', contactController.update);

/** DELETE /dashboard/contacts/:id — soft-delete contact (returns JSON) */
router.delete('/:id', contactController.destroy);

module.exports = router;

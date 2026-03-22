'use strict';

/**
 * Link Page routes
 *
 * This router is mounted at TWO paths in the master router:
 *   - /dashboard/link-pages  (dashboard management — auth required)
 *   - /p                     (public link pages — no auth)
 *
 * Because both namespaces share this router, route handlers inspect the
 * path context via req.user / auth guards to enforce access control.
 *
 * Static named paths (/create, /preview-theme) are defined before the
 * dynamic /:id / /:slug segments to avoid routing conflicts.
 */

const express     = require('express');
const rateLimit   = require('express-rate-limit');
const router      = express.Router();

const linkPageController    = require('../controllers/linkPageController');
const { requireAuth }       = require('../middleware/auth');

// ---------------------------------------------------------------------------
// Rate limiter for public click-tracking (prevent click-flood)
// ---------------------------------------------------------------------------
const clickTrackLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 30,              // 30 events per IP per minute
  message: { success: false },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Dashboard management routes (auth required)
// Mounted at /dashboard/link-pages
// ---------------------------------------------------------------------------

/** GET /dashboard/link-pages — list link pages */
router.get('/', requireAuth, linkPageController.index);

/** GET /dashboard/link-pages/create — new link page form */
router.get('/create', requireAuth, linkPageController.create);

/** GET /dashboard/link-pages/preview-theme?theme=X — theme preview HTML fragment */
router.get('/preview-theme', requireAuth, linkPageController.previewTheme);

/** POST /dashboard/link-pages — store new link page */
router.post('/', requireAuth, ...linkPageController.store);

/** GET /dashboard/link-pages/:id/edit — edit link page */
router.get('/:id/edit', requireAuth, linkPageController.edit);

/** PUT /dashboard/link-pages/:id — update link page */
router.put('/:id', requireAuth, ...linkPageController.update);

/** DELETE /dashboard/link-pages/:id — soft-delete link page */
router.delete('/:id', requireAuth, linkPageController.destroy);

/** GET /dashboard/link-pages/:id/analytics — per-page click analytics */
router.get('/:id/analytics', requireAuth, linkPageController.analytics);

// ---------------------------------------------------------------------------
// Public link page routes (no auth)
// Mounted at /p
// ---------------------------------------------------------------------------

/** GET /p/:slug — render public link-in-bio page */
router.get('/:slug', linkPageController.view);

/** POST /p/:slug/click — record link click (rate limited) */
router.post('/:slug/click', clickTrackLimiter, linkPageController.trackClick);

module.exports = router;

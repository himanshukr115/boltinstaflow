'use strict';

const slugify = require('slugify');
const { body, validationResult } = require('express-validator');

const LinkPage = require('../models/LinkPage');
const LinkPageClick = require('../models/LinkPageClick');
const AuditLog = require('../models/AuditLog');
const logger = require('../config/logger');

const THEMES = ['default', 'dark', 'minimal', 'gradient', 'neon', 'pastel'];

// ---------------------------------------------------------------------------
// Helper – generate a unique slug for a link page
// ---------------------------------------------------------------------------
async function generateSlug(base, userId) {
  const baseSlug = slugify(base, { lower: true, strict: true }).substring(0, 50);
  let slug = baseSlug;
  let counter = 1;
  while (await LinkPage.exists({ slug })) {
    slug = `${baseSlug}-${counter++}`;
  }
  return slug;
}

// ---------------------------------------------------------------------------
// index  (GET /dashboard/link-pages)
// ---------------------------------------------------------------------------
const index = async (req, res, next) => {
  try {
    const pages = await LinkPage.find({ userId: req.user._id, isDeleted: false })
      .sort({ createdAt: -1 })
      .lean();

    return res.render('link-page/index', {
      title: 'Link Pages',
      pages,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Link page index error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// create  (GET /dashboard/link-pages/create)
// ---------------------------------------------------------------------------
const create = (req, res) => {
  return res.render('link-page/create', {
    title: 'Create Link Page',
    themes: THEMES,
    formData: {},
    errors: [],
    user: req.user,
    error: req.flash('error'),
    success: req.flash('success'),
  });
};

// ---------------------------------------------------------------------------
// Shared validators
// ---------------------------------------------------------------------------
const linkPageValidators = [
  body('title').trim().notEmpty().withMessage('Page title is required.').isLength({ max: 100 }),
  body('bio').optional().trim().isLength({ max: 300 }).withMessage('Bio must be 300 characters or fewer.'),
  body('theme').optional().isIn(THEMES).withMessage('Invalid theme.'),
];

// ---------------------------------------------------------------------------
// store  (POST /dashboard/link-pages)
// ---------------------------------------------------------------------------
const store = [
  ...linkPageValidators,
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('link-page/create', {
        title: 'Create Link Page',
        themes: THEMES,
        formData: req.body,
        errors: errors.array(),
        user: req.user,
        error: [],
        success: [],
      });
    }

    try {
      const { title, bio, theme, links, avatarUrl } = req.body;

      const slug = await generateSlug(title, req.user._id);

      const page = await LinkPage.create({
        userId: req.user._id,
        title: title.trim(),
        slug,
        bio: bio ? bio.trim() : '',
        theme: theme || 'default',
        avatarUrl: avatarUrl || '',
        links: Array.isArray(links) ? links.slice(0, 50) : [],
        isPublished: false,
        totalClicks: 0,
      });

      await AuditLog.create({
        userId: req.user._id,
        action: 'linkPage.created',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        meta: { pageId: page._id, slug: page.slug },
      });

      req.flash('success', 'Link page created. Customise and publish it below.');
      return res.redirect(`/dashboard/link-pages/${page._id}/edit`);
    } catch (err) {
      logger.error('Link page store error', { error: err.message });
      return next(err);
    }
  },
];

// ---------------------------------------------------------------------------
// edit  (GET /dashboard/link-pages/:id/edit)
// ---------------------------------------------------------------------------
const edit = async (req, res, next) => {
  try {
    const page = await LinkPage.findOne({
      _id: req.params.id,
      userId: req.user._id,
      isDeleted: false,
    }).lean();

    if (!page) {
      req.flash('error', 'Link page not found.');
      return res.redirect('/dashboard/link-pages');
    }

    return res.render('link-page/edit', {
      title: `Edit – ${page.title}`,
      page,
      themes: THEMES,
      formData: page,
      errors: [],
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// update  (PUT /dashboard/link-pages/:id)
// ---------------------------------------------------------------------------
const update = [
  ...linkPageValidators,
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const page = await LinkPage.findById(req.params.id).lean().catch(() => null);
      return res.render('link-page/edit', {
        title: page ? `Edit – ${page.title}` : 'Edit Link Page',
        page,
        themes: THEMES,
        formData: req.body,
        errors: errors.array(),
        user: req.user,
        error: [],
        success: [],
      });
    }

    try {
      const { title, bio, theme, links, avatarUrl, isPublished } = req.body;

      const page = await LinkPage.findOneAndUpdate(
        { _id: req.params.id, userId: req.user._id, isDeleted: false },
        {
          title: title.trim(),
          bio: bio ? bio.trim() : '',
          theme: theme || 'default',
          avatarUrl: avatarUrl || '',
          links: Array.isArray(links) ? links.slice(0, 50) : [],
          isPublished: isPublished === 'on' || isPublished === 'true',
          updatedAt: new Date(),
        },
        { new: true },
      );

      if (!page) {
        req.flash('error', 'Link page not found.');
        return res.redirect('/dashboard/link-pages');
      }

      req.flash('success', 'Link page updated.');
      return res.redirect(`/dashboard/link-pages/${page._id}/edit`);
    } catch (err) {
      logger.error('Link page update error', { error: err.message });
      return next(err);
    }
  },
];

// ---------------------------------------------------------------------------
// destroy  (DELETE /dashboard/link-pages/:id)
// ---------------------------------------------------------------------------
const destroy = async (req, res, next) => {
  try {
    const page = await LinkPage.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, isDeleted: false },
      { isDeleted: true, deletedAt: new Date() },
      { new: true },
    );

    if (!page) {
      req.flash('error', 'Link page not found.');
      return res.redirect('/dashboard/link-pages');
    }

    await AuditLog.create({
      userId: req.user._id,
      action: 'linkPage.deleted',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { pageId: req.params.id, slug: page.slug },
    });

    req.flash('success', 'Link page deleted.');
    return res.redirect('/dashboard/link-pages');
  } catch (err) {
    logger.error('Link page destroy error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// view  (GET /p/:slug)  – PUBLIC, no auth required
// ---------------------------------------------------------------------------
const view = async (req, res, next) => {
  try {
    const page = await LinkPage.findOne({
      slug: req.params.slug,
      isPublished: true,
      isDeleted: false,
    }).lean();

    if (!page) {
      return res.status(404).render('errors/404', { title: 'Page Not Found' });
    }

    // Increment view count asynchronously
    LinkPage.findByIdAndUpdate(page._id, { $inc: { totalViews: 1 } }).catch((err) =>
      logger.warn('View count update failed', { error: err.message }),
    );

    return res.render('link-page/view', {
      title: page.title,
      page,
      layout: false, // Standalone page, no nav wrapper
    });
  } catch (err) {
    logger.error('Link page view error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// trackClick  (POST /p/:slug/click)  → JSON  – PUBLIC
// ---------------------------------------------------------------------------
const trackClick = async (req, res, next) => {
  const { linkIndex, linkUrl } = req.body;

  try {
    const page = await LinkPage.findOne({
      slug: req.params.slug,
      isPublished: true,
      isDeleted: false,
    }).lean();

    if (!page) {
      return res.status(404).json({ success: false });
    }

    // Record the click event
    await LinkPageClick.create({
      pageId: page._id,
      userId: page.userId,
      linkIndex: linkIndex != null ? Number(linkIndex) : null,
      linkUrl: linkUrl || '',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      referer: req.headers['referer'] || '',
    });

    // Increment counter on the link entry in the page's links array
    if (linkIndex != null) {
      const inc = {};
      inc[`links.${linkIndex}.clicks`] = 1;
      await LinkPage.findByIdAndUpdate(page._id, { $inc: { totalClicks: 1, ...inc } });
    } else {
      await LinkPage.findByIdAndUpdate(page._id, { $inc: { totalClicks: 1 } });
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('Track click error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// analytics  (GET /dashboard/link-pages/:id/analytics)
// ---------------------------------------------------------------------------
const analytics = async (req, res, next) => {
  try {
    const page = await LinkPage.findOne({
      _id: req.params.id,
      userId: req.user._id,
      isDeleted: false,
    }).lean();

    if (!page) {
      req.flash('error', 'Link page not found.');
      return res.redirect('/dashboard/link-pages');
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Aggregate daily clicks
    const dailyClicks = await LinkPageClick.aggregate([
      { $match: { pageId: page._id, createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Per-link click breakdown
    const linkBreakdown = await LinkPageClick.aggregate([
      { $match: { pageId: page._id, linkIndex: { $ne: null } } },
      { $group: { _id: '$linkIndex', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    const totalClicks = await LinkPageClick.countDocuments({ pageId: page._id });

    return res.render('link-page/analytics', {
      title: `Analytics – ${page.title}`,
      page,
      dailyClicks,
      linkBreakdown,
      totalClicks,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Link page analytics error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// previewTheme  (GET /dashboard/link-pages/preview-theme)  → HTML fragment
// ---------------------------------------------------------------------------
const previewTheme = async (req, res, next) => {
  const { theme } = req.query;

  if (!THEMES.includes(theme)) {
    return res.status(400).send('Invalid theme');
  }

  try {
    // Return a minimal EJS fragment for the selected theme
    return res.render('link-page/theme-preview', {
      theme,
      title: 'Preview',
      layout: false,
    });
  } catch (err) {
    logger.error('Preview theme error', { error: err.message });
    return next(err);
  }
};

module.exports = {
  index,
  create,
  store,
  edit,
  update,
  destroy,
  view,
  trackClick,
  analytics,
  previewTheme,
};

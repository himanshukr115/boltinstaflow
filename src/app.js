require('express-async-errors');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const flash = require('connect-flash');
const methodOverride = require('method-override');
const passport = require('passport');
const csurf = require('csurf');
const mongoose = require('mongoose');

const { applySecurityMiddleware } = require('./middleware/security');
const { requestLogger } = require('./middleware/requestLogger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { globalLimiter } = require('./middleware/rateLimiter');
const { createSessionMiddleware } = require('./config/session');
const configurePassport = require('./config/passport');
const routes = require('./routes/index');
const logger = require('./config/logger');

function createApp() {
  const app = express();

  applySecurityMiddleware(app);

  app.set('view engine', 'ejs')


  app.set('views', path.join(__dirname, '..', 'views'));
  // app.set('views', path.join(__dirname, 'views'));
  app.set('x-powered-by', false);

  app.use(requestLogger);

  app.use((req, res, next) => {
    if (
      req.originalUrl.startsWith('/webhooks/razorpay') ||
      req.originalUrl.startsWith('/webhooks/cashfree') ||
      req.originalUrl.startsWith('/webhooks/instagram')
    ) {
      express.raw({ type: 'application/json', limit: '1mb' })(req, res, next);
    } else {
      express.json({ limit: '10mb' })(req, res, next);
    }
  });
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser(process.env.APP_SECRET));
  app.use(methodOverride('_method'));

  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '7d' : '0',
    etag: true,
    lastModified: true,
  }));

  const sessionMiddleware = createSessionMiddleware(mongoose.connection);
  app.use(sessionMiddleware);

  configurePassport(passport);
  app.use(passport.initialize());
  app.use(passport.session());

  app.use(flash());

  const csrfProtection = csurf({ cookie: false });
  app.use((req, res, next) => {
    if (req.csrfExcluded) return next();
    const excluded = [
      '/webhooks/razorpay',
      '/webhooks/cashfree',
      '/webhooks/instagram',
      '/api/v1',
    ];
    const isExcluded = excluded.some((p) => req.path.startsWith(p));
    if (isExcluded) return next();
    csrfProtection(req, res, next);
  });

  app.use(globalLimiter);

  app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.isAuthenticated = req.isAuthenticated ? req.isAuthenticated() : false;
    res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
    res.locals.flashMessages = {
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    };
    res.locals.env = process.env.NODE_ENV || 'development';
    res.locals.appName = process.env.APP_NAME || 'InstaFlow';
    res.locals.appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    next();
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      env: process.env.NODE_ENV,
    });
  });

  app.get('/healthz', (req, res) => res.status(200).send('OK'));

  app.use('/', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };

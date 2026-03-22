'use strict';

const InstagramAccount = require('../models/InstagramAccount');
const AuditLog = require('../models/AuditLog');
const instagramService = require('../services/instagramService');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// index  (GET /dashboard/instagram)
// ---------------------------------------------------------------------------
const index = async (req, res, next) => {
  try {
    const accounts = await InstagramAccount.find({
      userId: req.user._id,
      isDeleted: false,
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.render('instagram/index', {
      title: 'Instagram Accounts',
      accounts,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Instagram index error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// connect  (GET /dashboard/instagram/connect)
// Redirects the user to the Instagram OAuth dialog
// ---------------------------------------------------------------------------
const connect = (req, res) => {
  try {
    const authUrl = instagramService.buildOAuthUrl(req.user._id);
    return res.redirect(authUrl);
  } catch (err) {
    logger.error('Instagram connect error', { error: err.message });
    req.flash('error', 'Could not initiate Instagram connection. Please try again.');
    return res.redirect('/dashboard/instagram');
  }
};

// ---------------------------------------------------------------------------
// callback  (GET /dashboard/instagram/callback)
// ---------------------------------------------------------------------------
const callback = async (req, res, next) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    req.flash('error', 'Instagram authorization was denied.');
    return res.redirect('/dashboard/instagram');
  }
  if (!code) {
    req.flash('error', 'Missing authorization code from Instagram.');
    return res.redirect('/dashboard/instagram');
  }

  try {
    // Exchange code for short-lived token then upgrade to long-lived token
    const tokenData = await instagramService.exchangeCodeForToken(code);
    const longLivedToken = await instagramService.getLongLivedToken(tokenData.access_token);

    // Fetch Instagram profile info
    const profile = await instagramService.getProfile(longLivedToken.access_token);

    // Upsert the account record
    const account = await InstagramAccount.findOneAndUpdate(
      { userId: req.user._id, instagramId: profile.id },
      {
        userId: req.user._id,
        instagramId: profile.id,
        username: profile.username,
        name: profile.name,
        biography: profile.biography,
        profilePictureUrl: profile.profile_picture_url,
        followersCount: profile.followers_count,
        followingCount: profile.follows_count,
        mediaCount: profile.media_count,
        accessToken: longLivedToken.access_token,
        tokenExpiresAt: new Date(Date.now() + longLivedToken.expires_in * 1000),
        isDeleted: false,
        lastSyncedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Subscribe to webhook for this account
    instagramService
      .subscribeWebhook(account.instagramId, longLivedToken.access_token)
      .catch((err) =>
        logger.warn('Webhook subscribe failed', { error: err.message, accountId: account._id }),
      );

    await AuditLog.create({
      userId: req.user._id,
      action: 'instagram.connected',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { instagramUsername: profile.username, instagramId: profile.id },
    });

    req.flash('success', `Successfully connected @${profile.username}.`);
    return res.redirect('/dashboard/instagram');
  } catch (err) {
    logger.error('Instagram callback error', { error: err.message });
    req.flash('error', 'Failed to connect Instagram account. Please try again.');
    return res.redirect('/dashboard/instagram');
  }
};

// ---------------------------------------------------------------------------
// disconnect  (POST /dashboard/instagram/:accountId/disconnect)
// ---------------------------------------------------------------------------
const disconnect = async (req, res, next) => {
  try {
    const account = await InstagramAccount.findOne({
      _id: req.params.accountId,
      userId: req.user._id,
      isDeleted: false,
    });

    if (!account) {
      req.flash('error', 'Account not found.');
      return res.redirect('/dashboard/instagram');
    }

    // Unsubscribe webhook before soft-deleting
    instagramService
      .unsubscribeWebhook(account.instagramId, account.accessToken)
      .catch((err) =>
        logger.warn('Webhook unsubscribe failed', { error: err.message, accountId: account._id }),
      );

    account.isDeleted = true;
    account.deletedAt = new Date();
    await account.save();

    await AuditLog.create({
      userId: req.user._id,
      action: 'instagram.disconnected',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      meta: { instagramUsername: account.username },
    });

    req.flash('success', `@${account.username} has been disconnected.`);
    return res.redirect('/dashboard/instagram');
  } catch (err) {
    logger.error('Instagram disconnect error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// refresh  (POST /dashboard/instagram/:accountId/refresh)  → JSON
// ---------------------------------------------------------------------------
const refresh = async (req, res, next) => {
  try {
    const account = await InstagramAccount.findOne({
      _id: req.params.accountId,
      userId: req.user._id,
      isDeleted: false,
    });

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    const refreshed = await instagramService.refreshLongLivedToken(account.accessToken);
    account.accessToken = refreshed.access_token;
    account.tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    await account.save();

    return res.json({ success: true, expiresAt: account.tokenExpiresAt });
  } catch (err) {
    logger.error('Instagram refresh error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// syncAccount  (POST /dashboard/instagram/:accountId/sync)  → JSON
// ---------------------------------------------------------------------------
const syncAccount = async (req, res, next) => {
  try {
    const account = await InstagramAccount.findOne({
      _id: req.params.accountId,
      userId: req.user._id,
      isDeleted: false,
    });

    if (!account) {
      return res.status(404).json({ success: false, message: 'Account not found.' });
    }

    const profile = await instagramService.getProfile(account.accessToken);

    account.username = profile.username;
    account.name = profile.name;
    account.biography = profile.biography;
    account.profilePictureUrl = profile.profile_picture_url;
    account.followersCount = profile.followers_count;
    account.followingCount = profile.follows_count;
    account.mediaCount = profile.media_count;
    account.lastSyncedAt = new Date();
    await account.save();

    return res.json({ success: true, account: account.toObject() });
  } catch (err) {
    logger.error('Instagram sync error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// getInsights  (GET /dashboard/instagram/:accountId/insights)
// ---------------------------------------------------------------------------
const getInsights = async (req, res, next) => {
  try {
    const account = await InstagramAccount.findOne({
      _id: req.params.accountId,
      userId: req.user._id,
      isDeleted: false,
    }).lean();

    if (!account) {
      req.flash('error', 'Account not found.');
      return res.redirect('/dashboard/instagram');
    }

    const period = req.query.period || 'day';
    const insights = await instagramService.getInsights(account.accessToken, account.instagramId, period);

    return res.render('instagram/insights', {
      title: `Insights – @${account.username}`,
      account,
      insights,
      period,
      user: req.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    logger.error('Instagram insights error', { error: err.message });
    return next(err);
  }
};

// ---------------------------------------------------------------------------
// accounts  (GET /dashboard/instagram/accounts.json)  → JSON (API use)
// ---------------------------------------------------------------------------
const accounts = async (req, res, next) => {
  try {
    const list = await InstagramAccount.find({ userId: req.user._id, isDeleted: false })
      .select('instagramId username name profilePictureUrl followersCount lastSyncedAt')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, accounts: list });
  } catch (err) {
    logger.error('Instagram accounts API error', { error: err.message });
    return next(err);
  }
};

module.exports = {
  index,
  connect,
  callback,
  disconnect,
  refresh,
  syncAccount,
  getInsights,
  accounts,
};

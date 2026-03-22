'use strict';

/**
 * Instagram / Meta Graph API Service
 *
 * IMPORTANT NOTES:
 * - All API calls use the official Meta Graph API v18.0 only.
 * - Sending DMs (sendDM, sendDMTemplate) requires:
 *     * A Facebook Page connected to the Instagram Business/Creator account
 *     * The instagram_manage_messages permission, approved via App Review
 *     * pages_messaging permission
 * - getConversations / getMessages require pages_messaging + pages_read_engagement
 * - getAccountInsights requires instagram_manage_insights (Business/Creator account only)
 * - subscribeWebhook requires a verified Facebook App with webhook subscription
 * - Rate limits enforced by Meta: ~200 API calls per user per hour for Graph API
 * - DM rate limits: https://developers.facebook.com/docs/messenger-platform/policy/policy-overview
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../config/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GRAPH_API_VERSION = 'v18.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const OAUTH_BASE_URL = 'https://api.instagram.com/oauth';

// Daily DM tracking – in-memory with hourly flush (replace with Redis in production)
const dmCountCache = new Map(); // key: `${igUserId}:${YYYY-MM-DD}`, value: count

// API call rate tracking – per account per hour
const apiCallCache = new Map(); // key: `${igUserId}:${YYYY-MM-DD-HH}`, value: count
const MAX_API_CALLS_PER_HOUR = 190; // stay under Meta's 200/hr limit

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ok(data) {
  return { success: true, data, error: null };
}

function fail(err, context) {
  const httpData = err.response && err.response.data;
  const message =
    (httpData && httpData.error && httpData.error.message) ||
    (httpData && JSON.stringify(httpData)) ||
    (err.message || String(err));
  logger.error(`[InstagramService] ${context}: ${message}`, {
    status: err.response && err.response.status,
    errorCode: httpData && httpData.error && httpData.error.code,
    stack: err.stack,
  });
  return { success: false, data: null, error: message };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function hourKey() {
  const d = new Date();
  return `${d.toISOString().slice(0, 13)}`; // YYYY-MM-DDTHH
}

function trackApiCall(igUserId) {
  const key = `${igUserId}:${hourKey()}`;
  const count = (apiCallCache.get(key) || 0) + 1;
  apiCallCache.set(key, count);
  return count;
}

function isRateLimited(igUserId) {
  const key = `${igUserId}:${hourKey()}`;
  return (apiCallCache.get(key) || 0) >= MAX_API_CALLS_PER_HOUR;
}

async function graphGet(path, params = {}) {
  const response = await axios.get(`${GRAPH_BASE_URL}${path}`, {
    params,
    timeout: 15000,
  });
  return response.data;
}

async function graphPost(path, data = {}, params = {}) {
  const response = await axios.post(`${GRAPH_BASE_URL}${path}`, data, {
    params,
    timeout: 15000,
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// Token encryption / decryption using AES-256-GCM
// ---------------------------------------------------------------------------
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16;

function getEncryptionKey() {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('APP_SECRET environment variable is not set');
  // Derive a 32-byte key via SHA-256
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt an Instagram access token for storage.
 * Returns a hex string: IV (12 bytes) + ciphertext + authTag (16 bytes)
 */
function encryptToken(token) {
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // pack: iv (12) + tag (16) + ciphertext
    const packed = Buffer.concat([iv, tag, encrypted]);
    return packed.toString('base64');
  } catch (err) {
    logger.error('[InstagramService] encryptToken error', { error: err.message });
    throw err;
  }
}

/**
 * Decrypt a stored encrypted access token.
 */
function decryptToken(encryptedToken) {
  try {
    const key = getEncryptionKey();
    const packed = Buffer.from(encryptedToken, 'base64');
    const iv = packed.slice(0, IV_LENGTH);
    const tag = packed.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = packed.slice(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    logger.error('[InstagramService] decryptToken error', { error: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * Generate the Instagram OAuth authorization URL.
 * Requires instagram_basic as a minimum scope.
 *
 * NOTE: instagram_manage_messages and pages_messaging require App Review approval.
 *
 * @param {string} state – CSRF state token
 */
function getOAuthUrl(state) {
  const appId = process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID;
  if (!appId) {
    logger.error('[InstagramService] INSTAGRAM_APP_ID or META_APP_ID is not set');
    return null;
  }
  const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;
  if (!redirectUri) {
    logger.error('[InstagramService] INSTAGRAM_REDIRECT_URI is not set');
    return null;
  }

  const scopes = [
    'instagram_basic',
    'instagram_manage_messages',
    'instagram_manage_insights',
    'pages_messaging',
    'pages_read_engagement',
    'pages_show_list',
    'public_profile',
  ].join(',');

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    scope: scopes,
    response_type: 'code',
    state: state || crypto.randomBytes(16).toString('hex'),
  });

  return `https://www.facebook.com/dialog/oauth?${params.toString()}`;
}

/**
 * Exchange an OAuth authorization code for a short-lived user access token.
 * Short-lived tokens expire in ~1 hour.
 */
async function exchangeCodeForToken(code) {
  try {
    const appId = process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;
    const redirectUri = process.env.INSTAGRAM_REDIRECT_URI;

    const params = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    });

    const response = await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );

    logger.info('[InstagramService] Short-lived token obtained');
    return ok(response.data); // { access_token, token_type }
  } catch (err) {
    return fail(err, 'exchangeCodeForToken');
  }
}

/**
 * Exchange a short-lived token for a long-lived token (valid ~60 days).
 */
async function getLongLivedToken(shortLivedToken) {
  try {
    const appSecret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;
    const data = await graphGet('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    });
    // data: { access_token, token_type, expires_in }
    logger.info('[InstagramService] Long-lived token obtained', {
      expiresIn: data.expires_in,
    });
    return ok(data);
  } catch (err) {
    return fail(err, 'getLongLivedToken');
  }
}

/**
 * Refresh a long-lived token before it expires (must be called within 60 days).
 * Returns a new long-lived token.
 */
async function refreshLongLivedToken(token) {
  try {
    const data = await graphGet('/oauth/access_token', {
      grant_type: 'ig_refresh_token',
      access_token: token,
    });
    logger.info('[InstagramService] Token refreshed', { expiresIn: data.expires_in });
    return ok(data);
  } catch (err) {
    return fail(err, 'refreshLongLivedToken');
  }
}

// ---------------------------------------------------------------------------
// User / Profile
// ---------------------------------------------------------------------------

/**
 * Fetch the authenticated user's Instagram profile.
 * Returns: id, username, profile_picture_url, account_type, followers_count
 *
 * Requires: instagram_basic scope
 */
async function getUserProfile(accessToken) {
  try {
    const data = await graphGet('/me', {
      fields: 'id,username,profile_picture_url,account_type,followers_count,media_count',
      access_token: accessToken,
    });
    return ok(data);
  } catch (err) {
    return fail(err, 'getUserProfile');
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/**
 * Fetch a list of recent media for an Instagram user.
 * Requires: instagram_basic scope.
 *
 * @param {string} instagramUserId – IG-scoped user ID
 * @param {string} accessToken
 * @param {number} limit – number of posts to return (max 100)
 */
async function getMediaList(instagramUserId, accessToken, limit = 20) {
  try {
    if (isRateLimited(instagramUserId)) {
      return fail(new Error('Hourly API rate limit reached for this account'), 'getMediaList');
    }
    trackApiCall(instagramUserId);

    const data = await graphGet(`/${instagramUserId}/media`, {
      fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',
      limit: Math.min(limit, 100),
      access_token: accessToken,
    });
    return ok(data); // { data: [...], paging: {...} }
  } catch (err) {
    return fail(err, 'getMediaList');
  }
}

// ---------------------------------------------------------------------------
// Direct Messages
// ---------------------------------------------------------------------------

/**
 * Send a DM to a recipient via the Messenger/Instagram Messaging API.
 *
 * IMPORTANT:
 * - Requires instagram_manage_messages permission (App Review required)
 * - Requires a Facebook Page connected to the IG Business/Creator account
 * - The recipient must have previously messaged the account (24-hour window)
 * - Subject to Meta's messaging rate limits (typically 1 message per second per recipient)
 *
 * @param {string} recipientId  – Instagram-scoped user ID of the recipient
 * @param {string} message      – plain text message content
 * @param {string} accessToken  – Page access token (not user token)
 */
async function sendDM(recipientId, message, accessToken) {
  try {
    // Rate limit check
    const igUserId = 'page'; // use page as proxy key since we have page token
    const dmKey = `dm:${recipientId}:${todayKey()}`;
    const dmCount = (dmCountCache.get(dmKey) || 0) + 1;
    dmCountCache.set(dmKey, dmCount);

    const payload = {
      recipient: { id: recipientId },
      message: { text: message },
      messaging_type: 'RESPONSE', // RESPONSE | UPDATE | MESSAGE_TAG
    };

    const data = await graphPost('/me/messages', payload, {
      access_token: accessToken,
    });

    logger.info('[InstagramService] DM sent', {
      recipientId,
      messageId: data.message_id,
      dailyCount: dmCount,
    });

    return ok({ ...data, dailyDmCount: dmCount });
  } catch (err) {
    return fail(err, 'sendDM');
  }
}

/**
 * Send a structured/template DM (e.g. quick replies, buttons).
 *
 * IMPORTANT: Same permissions required as sendDM.
 * Template messages using MESSAGE_TAG can be sent outside the 24-hour window
 * for approved use cases only (e.g. CONFIRMED_EVENT_UPDATE, POST_PURCHASE_UPDATE).
 *
 * @param {string} recipientId
 * @param {object} templateData – Messenger message object (attachment, quick_replies, etc.)
 * @param {string} accessToken  – Page access token
 */
async function sendDMTemplate(recipientId, templateData, accessToken) {
  try {
    const payload = {
      recipient: { id: recipientId },
      message: templateData,
      messaging_type: templateData.messaging_type || 'RESPONSE',
    };

    const data = await graphPost('/me/messages', payload, {
      access_token: accessToken,
    });

    logger.info('[InstagramService] Template DM sent', {
      recipientId,
      messageId: data.message_id,
    });

    return ok(data);
  } catch (err) {
    return fail(err, 'sendDMTemplate');
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * List DM conversations for a Facebook Page (connected to IG Business account).
 *
 * Requires: pages_messaging, pages_read_engagement permissions.
 *
 * @param {string} pageId          – Facebook Page ID
 * @param {string} pageAccessToken – Page-level access token
 */
async function getConversations(pageId, pageAccessToken) {
  try {
    const data = await graphGet(`/${pageId}/conversations`, {
      platform: 'instagram',
      fields: 'id,participants,updated_time,message_count,unread_count',
      access_token: pageAccessToken,
    });
    return ok(data);
  } catch (err) {
    return fail(err, 'getConversations');
  }
}

/**
 * Fetch messages within a conversation.
 *
 * Requires: pages_messaging, pages_read_engagement permissions.
 *
 * @param {string} conversationId
 * @param {string} pageAccessToken
 */
async function getMessages(conversationId, pageAccessToken) {
  try {
    const data = await graphGet(`/${conversationId}/messages`, {
      fields: 'id,message,from,to,created_time,attachments',
      access_token: pageAccessToken,
    });
    return ok(data);
  } catch (err) {
    return fail(err, 'getMessages');
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Subscribe a Facebook Page to Instagram webhook events.
 *
 * Requires: pages_messaging permission, the app must be subscribed to the page.
 *
 * @param {string} pageId
 * @param {string} pageAccessToken
 */
async function subscribeWebhook(pageId, pageAccessToken) {
  try {
    const data = await graphPost(
      `/${pageId}/subscribed_apps`,
      {},
      {
        subscribed_fields: [
          'messages',
          'messaging_postbacks',
          'messaging_optins',
          'message_deliveries',
          'message_reads',
          'messaging_referrals',
        ].join(','),
        access_token: pageAccessToken,
      }
    );
    logger.info('[InstagramService] Webhook subscribed', { pageId, success: data.success });
    return ok(data);
  } catch (err) {
    return fail(err, 'subscribeWebhook');
  }
}

/**
 * Handle Meta's webhook verification challenge.
 * Called when Meta sends a GET request to your webhook endpoint.
 *
 * @param {string} token     – hub.verify_token from the request query
 * @param {string} challenge – hub.challenge from the request query
 * @returns {{ success, data: { challenge } }} – return the challenge string in your route handler
 */
function verifyWebhookToken(token, challenge) {
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) {
    return fail(new Error('META_WEBHOOK_VERIFY_TOKEN is not set'), 'verifyWebhookToken');
  }
  if (token !== verifyToken) {
    return { success: false, data: null, error: 'Webhook token mismatch' };
  }
  return ok({ challenge });
}

// ---------------------------------------------------------------------------
// Analytics / Insights
// ---------------------------------------------------------------------------

/**
 * Fetch account-level insights from the Instagram Graph API.
 *
 * IMPORTANT: Only available for Instagram Business or Creator accounts.
 * Requires instagram_manage_insights permission (App Review required).
 *
 * @param {string} igUserId    – IG Business/Creator user ID
 * @param {string} accessToken
 * @param {string[]} metrics   – e.g. ['impressions','reach','profile_views','follower_count']
 * @param {string} period      – 'day' | 'week' | 'days_28' | 'month' | 'lifetime'
 */
async function getAccountInsights(igUserId, accessToken, metrics, period = 'day') {
  try {
    if (!metrics || metrics.length === 0) {
      metrics = ['impressions', 'reach', 'profile_views', 'follower_count'];
    }

    if (isRateLimited(igUserId)) {
      return fail(new Error('Hourly API rate limit reached for this account'), 'getAccountInsights');
    }
    trackApiCall(igUserId);

    const data = await graphGet(`/${igUserId}/insights`, {
      metric: metrics.join(','),
      period,
      access_token: accessToken,
    });
    return ok(data);
  } catch (err) {
    return fail(err, 'getAccountInsights');
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getOAuthUrl,
  exchangeCodeForToken,
  getLongLivedToken,
  refreshLongLivedToken,
  getUserProfile,
  getMediaList,
  sendDM,
  sendDMTemplate,
  getConversations,
  getMessages,
  subscribeWebhook,
  getAccountInsights,
  verifyWebhookToken,
  encryptToken,
  decryptToken,
};

'use strict';

/**
 * Pre-built automation templates for the Instagram automation SaaS.
 *
 * Each template provides a ready-to-use starting point that users can
 * customise. Templates are stored in the database and referenced when a
 * user creates a new automation from a template.
 *
 * Field glossary:
 *  id           - stable slug identifier (used for lookup / seeding)
 *  name         - human-readable display name
 *  description  - short marketing copy shown in the template gallery
 *  category     - one of: welcome | lead_gen | support | engagement
 *  triggerType  - instagram webhook event type that starts the automation
 *  triggerConfig - type-specific settings (keyword, etc.)
 *  steps        - ordered array of action steps executed when triggered
 *  tags         - searchable keyword tags
 *  thumbnail    - icon / illustration name for the frontend to render
 */

const AUTOMATION_TEMPLATES = [
  // ─── 1. Welcome DM ──────────────────────────────────────────────────────────
  {
    id: 'welcome-dm',
    name: 'Welcome DM',
    description: 'Automatically send a warm welcome message to every new follower. Make a great first impression and start building a relationship from day one.',
    category: 'welcome',
    triggerType: 'new_follower',
    triggerConfig: {
      event: 'new_follower',
    },
    steps: [
      {
        order: 1,
        type: 'send_dm',
        config: {
          message: 'Hey {{username}}! Thanks for following us. We are thrilled to have you here!\n\nStay tuned — we share exclusive tips, offers, and behind-the-scenes content just for our community. Feel free to DM us anytime if you have questions. We would love to hear from you!',
          delaySeconds: 30,
        },
      },
    ],
    tags: ['welcome', 'new-follower', 'onboarding', 'dm'],
    thumbnail: 'hand-wave',
  },

  // ─── 2. Keyword Lead Capture ──────────────────────────────────────────────
  {
    id: 'keyword-lead-capture',
    name: 'Keyword Lead Capture',
    description: 'When someone comments "FREE" on your post, instantly DM them a link to your lead magnet. Capture leads 24/7 without lifting a finger.',
    category: 'lead_gen',
    triggerType: 'comment_keyword',
    triggerConfig: {
      event: 'comment_keyword',
      keywords: ['FREE', 'free', 'Free'],
      matchType: 'exact',
      postScope: 'all',
    },
    steps: [
      {
        order: 1,
        type: 'like_comment',
        config: {},
      },
      {
        order: 2,
        type: 'send_dm',
        config: {
          message: 'Hey {{username}}! Here is your FREE resource as promised:\n\n{{lead_magnet_url}}\n\nDownload it, enjoy it, and let me know what you think! Drop a DM if you have any questions.',
          delaySeconds: 10,
        },
      },
      {
        order: 3,
        type: 'add_tag',
        config: {
          tag: 'lead-free-resource',
        },
      },
    ],
    tags: ['lead-gen', 'free', 'comment', 'keyword', 'magnet'],
    thumbnail: 'magnet',
  },

  // ─── 3. FAQ Auto Reply (Price) ────────────────────────────────────────────
  {
    id: 'faq-price-reply',
    name: 'FAQ Auto Reply - Price',
    description: 'Reply automatically when someone DMs the word "PRICE". Send them your pricing details instantly so they do not have to wait.',
    category: 'support',
    triggerType: 'dm_keyword',
    triggerConfig: {
      event: 'dm_keyword',
      keywords: ['PRICE', 'price', 'Price', 'pricing', 'PRICING', 'cost', 'COST', 'how much'],
      matchType: 'contains',
    },
    steps: [
      {
        order: 1,
        type: 'send_dm',
        config: {
          message: 'Hi {{username}}! Thanks for your interest in our pricing.\n\nHere\'s a quick overview:\n\n- Starter: Rs.999/month\n- Pro: Rs.2,499/month\n- Business: Rs.5,999/month\n\nAll plans include a 7-day free trial. Check the full details here: {{pricing_url}}\n\nWant help choosing the right plan? Just reply and we\'ll connect you with our team!',
          delaySeconds: 5,
        },
      },
      {
        order: 2,
        type: 'add_tag',
        config: {
          tag: 'pricing-inquiry',
        },
      },
    ],
    tags: ['faq', 'price', 'dm', 'keyword', 'support'],
    thumbnail: 'currency-rupee',
  },

  // ─── 4. Story Mention Thank You ───────────────────────────────────────────
  {
    id: 'story-mention-thankyou',
    name: 'Story Mention Thank You',
    description: 'Automatically thank users who mention you in their Instagram Stories. Turn every mention into a meaningful connection.',
    category: 'engagement',
    triggerType: 'story_mention',
    triggerConfig: {
      event: 'story_mention',
    },
    steps: [
      {
        order: 1,
        type: 'send_dm',
        config: {
          message: 'Hey {{username}}! We just saw that you mentioned us in your story — thank you so much! It really means the world to us.\n\nWe\'d love to reshare your story to our community (with your permission, of course). Just reply YES and we\'ll take care of the rest!',
          delaySeconds: 60,
        },
      },
      {
        order: 2,
        type: 'add_tag',
        config: {
          tag: 'story-mention',
        },
      },
    ],
    tags: ['story', 'mention', 'engagement', 'thank-you', 'ugc'],
    thumbnail: 'star',
  },

  // ─── 5. Contest Entry ─────────────────────────────────────────────────────
  {
    id: 'contest-entry',
    name: 'Contest Entry Confirmation',
    description: 'Let participants comment "ENTER" on your giveaway post and instantly receive a DM confirming their entry. Handles unlimited entries automatically.',
    category: 'engagement',
    triggerType: 'comment_keyword',
    triggerConfig: {
      event: 'comment_keyword',
      keywords: ['ENTER', 'enter', 'Enter'],
      matchType: 'exact',
      postScope: 'specific_post',
    },
    steps: [
      {
        order: 1,
        type: 'like_comment',
        config: {},
      },
      {
        order: 2,
        type: 'send_dm',
        config: {
          message: 'Hey {{username}}! You\'re officially entered in the giveaway!\n\nYour entry number: #{{entry_number}}\n\nWinner will be announced on {{draw_date}}. Good luck!\n\nBonus entries:\n- Tag a friend in the comments (+1 entry)\n- Share this post to your story (+2 entries)\n\nWe\'ll DM the winner directly — stay tuned!',
          delaySeconds: 15,
        },
      },
      {
        order: 3,
        type: 'add_tag',
        config: {
          tag: 'contest-entrant',
        },
      },
      {
        order: 4,
        type: 'increment_counter',
        config: {
          counterKey: 'contest_entries',
        },
      },
    ],
    tags: ['contest', 'giveaway', 'enter', 'comment', 'engagement'],
    thumbnail: 'trophy',
  },

  // ─── 6. Product Info Request ──────────────────────────────────────────────
  {
    id: 'product-info-request',
    name: 'Product Info Request',
    description: 'When someone comments or DMs "INFO" about your product, send them a detailed description with a call-to-action to buy or book a demo.',
    category: 'lead_gen',
    triggerType: 'comment_keyword',
    triggerConfig: {
      event: 'comment_keyword',
      keywords: ['INFO', 'info', 'Info', 'details', 'DETAILS', 'more info', 'tell me more'],
      matchType: 'contains',
      postScope: 'all',
    },
    steps: [
      {
        order: 1,
        type: 'like_comment',
        config: {},
      },
      {
        order: 2,
        type: 'send_dm',
        config: {
          message: 'Hi {{username}}! Thanks for your interest!\n\nHere\'s everything you need to know about {{product_name}}:\n\n{{feature_1}}\n{{feature_2}}\n{{feature_3}}\n\nPrice: Starting at {{start_price}}\n\nSee full details and order here: {{product_url}}\n\nHave questions? Just reply to this message — we\'re happy to help!',
          delaySeconds: 20,
        },
      },
      {
        order: 3,
        type: 'add_tag',
        config: {
          tag: 'product-inquiry',
        },
      },
    ],
    tags: ['product', 'info', 'lead-gen', 'sales', 'keyword'],
    thumbnail: 'shopping-bag',
  },

  // ─── 7. Appointment Booking ───────────────────────────────────────────────
  {
    id: 'appointment-booking',
    name: 'Appointment Booking',
    description: 'Comment or DM "BOOK" triggers an instant reply with your booking link. Never miss a potential client who is ready to schedule.',
    category: 'lead_gen',
    triggerType: 'comment_keyword',
    triggerConfig: {
      event: 'comment_keyword',
      keywords: ['BOOK', 'book', 'Book', 'BOOKING', 'booking', 'schedule', 'SCHEDULE', 'appointment'],
      matchType: 'contains',
      postScope: 'all',
    },
    steps: [
      {
        order: 1,
        type: 'like_comment',
        config: {},
      },
      {
        order: 2,
        type: 'send_dm',
        config: {
          message: 'Hi {{username}}! Let\'s get you booked in!\n\nClick the link below to choose your preferred date and time:\n\n{{booking_url}}\n\nSlots fill up quickly, so book yours while it\'s available!\n\nIf you have any questions before your appointment, feel free to DM us. See you soon!',
          delaySeconds: 10,
        },
      },
      {
        order: 3,
        type: 'add_tag',
        config: {
          tag: 'booking-intent',
        },
      },
    ],
    tags: ['booking', 'appointment', 'schedule', 'calendar', 'lead-gen'],
    thumbnail: 'calendar',
  },

  // ─── 8. Feedback Request Sequence ────────────────────────────────────────
  {
    id: 'feedback-request-sequence',
    name: 'Post-Purchase Feedback Sequence',
    description: 'A 3-step sequence: an immediate thank-you, a check-in after 24 hours, and a feedback request after 48 hours. Build loyalty and collect reviews on autopilot.',
    category: 'engagement',
    triggerType: 'dm_keyword',
    triggerConfig: {
      event: 'dm_keyword',
      keywords: ['PURCHASED', 'purchased', 'ordered', 'ORDERED', 'bought', 'BOUGHT'],
      matchType: 'contains',
    },
    steps: [
      {
        order: 1,
        type: 'send_dm',
        config: {
          message: 'Hi {{username}}! Thank you so much for your purchase — we\'re thrilled you chose us!\n\nYour order is being processed and you\'ll receive a confirmation email shortly.\n\nIf you need anything at all, just reply here — we\'re always happy to help!',
          delaySeconds: 0,
        },
      },
      {
        order: 2,
        type: 'delay',
        config: {
          delaySeconds: 86400,
        },
      },
      {
        order: 3,
        type: 'send_dm',
        config: {
          message: 'Hey {{username}}! Just checking in — how\'s everything going with your recent purchase?\n\nWe hope you\'re enjoying it! If you have any questions or need help getting set up, we\'re here for you.',
          delaySeconds: 0,
        },
      },
      {
        order: 4,
        type: 'delay',
        config: {
          delaySeconds: 86400,
        },
      },
      {
        order: 5,
        type: 'send_dm',
        config: {
          message: 'Hi {{username}}! We\'d love to hear what you think about your experience with us.\n\nCould you spare 2 minutes to leave us a quick review? Your feedback helps us improve and helps others discover us:\n\n{{review_url}}\n\nAs a thank-you, here\'s a 10% discount on your next order: {{discount_code}}\n\nThank you so much — you\'re amazing!',
          delaySeconds: 0,
        },
      },
      {
        order: 6,
        type: 'add_tag',
        config: {
          tag: 'feedback-requested',
        },
      },
    ],
    tags: ['feedback', 'review', 'post-purchase', 'sequence', 'loyalty'],
    thumbnail: 'chat-bubble-heart',
  },

  // ─── 9. Newsletter Signup ─────────────────────────────────────────────────
  {
    id: 'newsletter-signup',
    name: 'Newsletter Signup via DM',
    description: 'DM or comment "NEWSLETTER" to receive an instant link to your email list signup form. Grow your email list directly from Instagram.',
    category: 'lead_gen',
    triggerType: 'comment_keyword',
    triggerConfig: {
      event: 'comment_keyword',
      keywords: ['NEWSLETTER', 'newsletter', 'Newsletter', 'subscribe', 'SUBSCRIBE', 'email list'],
      matchType: 'contains',
      postScope: 'all',
    },
    steps: [
      {
        order: 1,
        type: 'like_comment',
        config: {},
      },
      {
        order: 2,
        type: 'send_dm',
        config: {
          message: 'Hey {{username}}! Awesome — you\'re one step away from joining our newsletter community!\n\nClick below to sign up and get:\n- Weekly tips and strategies\n- Exclusive subscriber-only offers\n- Be the first to know about new launches\n\n{{newsletter_signup_url}}\n\nWelcome aboard — can\'t wait to land in your inbox!',
          delaySeconds: 10,
        },
      },
      {
        order: 3,
        type: 'add_tag',
        config: {
          tag: 'newsletter-intent',
        },
      },
    ],
    tags: ['newsletter', 'email', 'subscribe', 'lead-gen', 'list-building'],
    thumbnail: 'envelope',
  },

  // ─── 10. Support Ticket ───────────────────────────────────────────────────
  {
    id: 'support-ticket',
    name: 'Instant Support Response',
    description: 'When someone DMs "HELP" or "SUPPORT", automatically acknowledge their request, generate a ticket reference, and set expectations for response time.',
    category: 'support',
    triggerType: 'dm_keyword',
    triggerConfig: {
      event: 'dm_keyword',
      keywords: [
        'HELP', 'help', 'Help',
        'SUPPORT', 'support', 'Support',
        'issue', 'ISSUE',
        'problem', 'PROBLEM',
        'not working', 'broken',
      ],
      matchType: 'contains',
    },
    steps: [
      {
        order: 1,
        type: 'send_dm',
        config: {
          message: 'Hi {{username}}! We\'re sorry to hear you\'re having trouble — we\'re on it!\n\nYour support ticket has been created:\nTicket ID: #{{ticket_id}}\nPriority: Standard\nExpected response: Within 2 business hours\n\nOur support team has been notified and will reach out to you shortly. In the meantime, you might find an answer in our Help Center:\n\n{{help_center_url}}\n\nThank you for your patience — we\'ll get this sorted for you!',
          delaySeconds: 5,
        },
      },
      {
        order: 2,
        type: 'create_support_ticket',
        config: {
          priority: 'standard',
          source: 'instagram_dm',
        },
      },
      {
        order: 3,
        type: 'add_tag',
        config: {
          tag: 'support-ticket-open',
        },
      },
      {
        order: 4,
        type: 'notify_team',
        config: {
          channel: 'support',
          message: 'New support ticket from Instagram DM — User: {{username}}',
        },
      },
    ],
    tags: ['support', 'help', 'ticket', 'customer-service', 'dm'],
    thumbnail: 'lifebuoy',
  },
];

module.exports = AUTOMATION_TEMPLATES;

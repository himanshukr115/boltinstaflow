'use strict';

const LocalStrategy = require('passport-local').Strategy;
const bcryptjs = require('bcryptjs');
const User = require('../models/User');

/**
 * Configure Passport.js strategies and serialization.
 * @param {import('passport').PassportStatic} passport - The passport instance to configure.
 */
function configurePassport(passport) {
  // Local strategy: authenticate with email and password
  passport.use(
    'local',
    new LocalStrategy(
      {
        usernameField: 'email',
        passwordField: 'password',
        passReqToCallback: false,
      },
      async (email, password, done) => {
        try {
          // Normalise email to lowercase before querying
          const normalizedEmail = email.toLowerCase().trim();

          const user = await User.findOne({ email: normalizedEmail })
            .select('+password +isActive +role +subscription')
            .lean(false);

          if (!user) {
            return done(null, false, {
              message: 'No account found with that email address.',
            });
          }

          // Account deactivated check
          if (user.isActive === false) {
            return done(null, false, {
              message: 'Your account has been deactivated. Please contact support.',
            });
          }

          // Password comparison using bcryptjs
          const isMatch = await bcryptjs.compare(password, user.password);
          if (!isMatch) {
            return done(null, false, {
              message: 'Incorrect password. Please try again.',
            });
          }

          // Update last login timestamp (fire-and-forget, non-blocking)
          User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() }).exec().catch(() => {});

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  // Serialize: store only the user's MongoDB _id in the session
  passport.serializeUser((user, done) => {
    done(null, user._id.toString());
  });

  // Deserialize: reload user from DB on every authenticated request
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id)
        .select('-password')
        .populate('subscription')
        .lean(false);

      if (!user) {
        // User was deleted after session was created – clear the session
        return done(null, false);
      }

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  });
}

module.exports = configurePassport;

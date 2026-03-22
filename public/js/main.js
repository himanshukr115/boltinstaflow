/**
 * InstaFlow - Main Frontend JavaScript
 * Handles: flash messages, mobile nav, confirm modals, AJAX coupon, Razorpay, notifications, tabs
 */

(function () {
  'use strict';

  // =====================================================
  // Flash Message Auto-Dismiss
  // =====================================================
  function initFlashMessages() {
    const flashAlerts = document.querySelectorAll('.flash-alert');

    flashAlerts.forEach(function (alert) {
      // Auto-dismiss after 4 seconds
      const timer = setTimeout(function () {
        dismissFlash(alert);
      }, 4000);

      // Allow manual dismiss
      const closeBtn = alert.querySelector('button[onclick]');
      if (closeBtn) {
        closeBtn.addEventListener('click', function () {
          clearTimeout(timer);
        });
      }
    });
  }

  function dismissFlash(alert) {
    alert.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    alert.style.opacity = '0';
    alert.style.transform = 'translateY(-4px)';
    setTimeout(function () {
      if (alert.parentElement) {
        alert.remove();
      }
    }, 400);
  }


  // =====================================================
  // Mobile Navigation Toggle
  // =====================================================
  function initMobileNav() {
    const mobileBtn = document.getElementById('mobile-menu-btn');
    const mobileMenu = document.getElementById('mobile-menu');
    const hamburgerIcon = document.getElementById('hamburger-icon');
    const closeIcon = document.getElementById('close-icon');

    if (!mobileBtn || !mobileMenu) return;

    mobileBtn.addEventListener('click', function () {
      const isOpen = !mobileMenu.classList.contains('hidden');

      mobileMenu.classList.toggle('hidden', isOpen);
      if (hamburgerIcon) hamburgerIcon.classList.toggle('hidden', !isOpen);
      if (closeIcon) closeIcon.classList.toggle('hidden', isOpen);
    });

    // Close on outside click
    document.addEventListener('click', function (e) {
      if (!mobileMenu.contains(e.target) && !mobileBtn.contains(e.target)) {
        mobileMenu.classList.add('hidden');
        if (hamburgerIcon) hamburgerIcon.classList.remove('hidden');
        if (closeIcon) closeIcon.classList.add('hidden');
      }
    });
  }


  // =====================================================
  // User Dropdown
  // =====================================================
  function initUserDropdown() {
    const btn = document.getElementById('user-menu-btn');
    const dropdown = document.getElementById('user-dropdown');
    const wrapper = document.getElementById('user-dropdown-wrapper');

    if (!btn || !dropdown) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');

      // Close notification dropdown if open
      const notifDropdown = document.getElementById('notification-dropdown');
      if (notifDropdown) notifDropdown.classList.add('hidden');
    });

    document.addEventListener('click', function (e) {
      if (wrapper && !wrapper.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });
  }


  // =====================================================
  // Notification Bell Dropdown
  // =====================================================
  function initNotificationDropdown() {
    const btn = document.getElementById('notification-btn');
    const dropdown = document.getElementById('notification-dropdown');
    const wrapper = document.getElementById('notification-dropdown-wrapper');

    if (!btn || !dropdown) return;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      dropdown.classList.toggle('hidden');

      // Close user dropdown if open
      const userDropdown = document.getElementById('user-dropdown');
      if (userDropdown) userDropdown.classList.add('hidden');
    });

    document.addEventListener('click', function (e) {
      if (wrapper && !wrapper.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });
  }


  // =====================================================
  // Confirm Modal (replaces browser confirm())
  // =====================================================
  let confirmCallback = null;

  function initConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    const cancelBtn = document.getElementById('confirm-cancel-btn');
    const okBtn = document.getElementById('confirm-ok-btn');
    const backdrop = document.getElementById('confirm-modal-backdrop');

    if (!modal) return;

    function closeModal() {
      modal.classList.add('hidden');
      confirmCallback = null;
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', closeModal);
    }

    if (backdrop) {
      backdrop.addEventListener('click', closeModal);
    }

    if (okBtn) {
      okBtn.addEventListener('click', function () {
        if (typeof confirmCallback === 'function') {
          confirmCallback();
        }
        closeModal();
      });
    }

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
        closeModal();
      }
    });
  }

  /**
   * Show confirm modal
   * @param {string} title - Modal title
   * @param {string} message - Modal message
   * @param {Function} callback - Called when user confirms
   */
  window.confirmModal = function (title, message, callback) {
    const modal = document.getElementById('confirm-modal');
    const titleEl = document.getElementById('confirm-modal-title');
    const messageEl = document.getElementById('confirm-modal-message');

    if (!modal) {
      // Fallback to browser confirm
      if (window.confirm(message)) {
        if (typeof callback === 'function') callback();
      }
      return;
    }

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;

    confirmCallback = callback;
    modal.classList.remove('hidden');
  };


  // =====================================================
  // AJAX Coupon Apply
  // =====================================================

  /**
   * Apply a coupon code via AJAX
   * @param {string} code - Coupon code
   * @param {string} planId - Plan ID
   * @param {Function} onSuccess - Callback on success ({ valid, discountText, discountAmount })
   * @param {Function} onError - Callback on error (message)
   */
  window.applyCouponAjax = async function (code, planId, onSuccess, onError) {
    try {
      const response = await fetch('/subscription/apply-coupon', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ code: code.trim(), planId })
      });

      const data = await response.json();

      if (data.valid) {
        if (typeof onSuccess === 'function') onSuccess(data);
      } else {
        if (typeof onError === 'function') onError(data.message || 'Invalid coupon code');
      }
    } catch (err) {
      if (typeof onError === 'function') onError('Failed to apply coupon. Please try again.');
    }
  };


  // =====================================================
  // Razorpay Checkout Integration
  // =====================================================

  /**
   * Initialize Razorpay payment
   * @param {Object} orderData - { orderId, amount, currency, planId, billingCycle, coupon }
   * @param {Object} options - Additional options { name, email, description, keyId, csrfToken }
   */
  window.initRazorpay = function (orderData, options) {
    if (typeof Razorpay === 'undefined') {
      console.error('Razorpay SDK not loaded');
      alert('Payment service not available. Please try again.');
      return;
    }

    const rzpOptions = {
      key: options.keyId || '',
      amount: orderData.amount,
      currency: orderData.currency || 'INR',
      name: 'InstaFlow',
      description: options.description || 'InstaFlow Subscription',
      order_id: orderData.orderId,
      theme: { color: '#2563eb' },
      prefill: {
        name: options.name || '',
        email: options.email || ''
      },
      handler: function (response) {
        // Create a form and submit to verify endpoint
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/subscription/razorpay-verify';

        const params = {
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_order_id: response.razorpay_order_id,
          razorpay_signature: response.razorpay_signature,
          planId: orderData.planId || '',
          billingCycle: orderData.billingCycle || 'monthly',
          coupon: orderData.coupon || '',
          _csrf: options.csrfToken || ''
        };

        Object.entries(params).forEach(function ([key, value]) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = key;
          input.value = value;
          form.appendChild(input);
        });

        document.body.appendChild(form);
        form.submit();
      },
      modal: {
        ondismiss: function () {
          if (typeof options.onDismiss === 'function') {
            options.onDismiss();
          }
        }
      }
    };

    const rzp = new Razorpay(rzpOptions);
    rzp.open();

    return rzp;
  };


  // =====================================================
  // Pricing Page: Monthly/Yearly Tab Switcher
  // =====================================================
  function initPricingToggle() {
    const toggle = document.getElementById('billing-toggle');
    if (!toggle) return;

    toggle.addEventListener('change', function () {
      const isYearly = this.checked;

      // Update all price values
      document.querySelectorAll('.price-value').forEach(function (el) {
        const monthly = el.dataset.monthly;
        const yearly = el.dataset.yearly;
        if (isYearly && yearly) {
          el.textContent = yearly;
        } else if (!isYearly && monthly) {
          el.textContent = monthly;
        }
      });

      // Show/hide yearly savings notes
      document.querySelectorAll('.yearly-note').forEach(function (el) {
        el.classList.toggle('hidden', !isYearly);
      });

      // Update billing cycle labels
      const monthlyLabel = document.getElementById('monthly-label');
      const yearlyLabel = document.getElementById('yearly-label');
      if (monthlyLabel) monthlyLabel.style.fontWeight = isYearly ? '400' : '600';
      if (yearlyLabel) yearlyLabel.style.fontWeight = isYearly ? '600' : '400';
    });
  }


  // =====================================================
  // Form Validation Helpers
  // =====================================================

  /**
   * Validate email format
   */
  window.validateEmail = function (email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  /**
   * Validate password strength (returns 0-4 score)
   */
  window.passwordStrength = function (password) {
    let score = 0;
    if (password.length >= 8) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;
    return score;
  };

  /**
   * Show inline form error
   */
  window.showFieldError = function (fieldId, message) {
    const field = document.getElementById(fieldId);
    if (!field) return;

    field.classList.add('border-red-500', 'focus:ring-red-500');

    let errorEl = field.parentElement.querySelector('.field-error');
    if (!errorEl) {
      errorEl = document.createElement('p');
      errorEl.className = 'field-error text-xs text-red-500 mt-1';
      field.parentElement.appendChild(errorEl);
    }
    errorEl.textContent = message;
  };

  /**
   * Clear inline form error
   */
  window.clearFieldError = function (fieldId) {
    const field = document.getElementById(fieldId);
    if (!field) return;

    field.classList.remove('border-red-500', 'focus:ring-red-500');

    const errorEl = field.parentElement.querySelector('.field-error');
    if (errorEl) errorEl.remove();
  };


  // =====================================================
  // General Tab Switcher
  // =====================================================

  /**
   * Initialize tab panels by data attribute
   * Usage: <button data-tab="panel-id"> + <div data-panel="panel-id">
   */
  function initTabs() {
    document.querySelectorAll('[data-tab]').forEach(function (tabBtn) {
      tabBtn.addEventListener('click', function () {
        const tabGroup = this.dataset.tabGroup || 'default';
        const targetPanel = this.dataset.tab;

        // Deactivate all tabs in group
        document.querySelectorAll('[data-tab][data-tab-group="' + tabGroup + '"], [data-tab]:not([data-tab-group])').forEach(function (btn) {
          btn.classList.remove('border-blue-600', 'text-blue-600');
          btn.classList.add('border-transparent', 'text-gray-500');
        });

        // Hide all panels
        document.querySelectorAll('[data-panel]').forEach(function (panel) {
          panel.classList.add('hidden');
        });

        // Activate current tab
        this.classList.remove('border-transparent', 'text-gray-500');
        this.classList.add('border-blue-600', 'text-blue-600');

        // Show target panel
        const panel = document.querySelector('[data-panel="' + targetPanel + '"]');
        if (panel) panel.classList.remove('hidden');
      });
    });
  }


  // =====================================================
  // Auto-resize textareas
  // =====================================================
  function initAutoResize() {
    document.querySelectorAll('textarea.auto-resize').forEach(function (textarea) {
      function resize() {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      }
      textarea.addEventListener('input', resize);
      resize();
    });
  }


  // =====================================================
  // Copy to clipboard helper
  // =====================================================
  window.copyToClipboard = function (text, btn) {
    navigator.clipboard.writeText(text).then(function () {
      if (btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () {
          btn.textContent = originalText;
        }, 2000);
      }
    }).catch(function () {
      // Fallback for older browsers
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'absolute';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    });
  };


  // =====================================================
  // Tooltip initialization (basic title-based)
  // =====================================================
  function initTooltips() {
    // Basic implementation - can be enhanced with a tooltip library
    document.querySelectorAll('[data-tooltip]').forEach(function (el) {
      el.addEventListener('mouseenter', function () {
        const tooltip = document.createElement('div');
        tooltip.className = 'fixed z-50 bg-gray-900 text-white text-xs rounded-lg px-2.5 py-1.5 pointer-events-none whitespace-nowrap shadow-lg';
        tooltip.textContent = this.dataset.tooltip;
        tooltip.id = 'active-tooltip';
        document.body.appendChild(tooltip);

        const rect = this.getBoundingClientRect();
        tooltip.style.top = (rect.bottom + 6) + 'px';
        tooltip.style.left = (rect.left + rect.width / 2 - tooltip.offsetWidth / 2) + 'px';
      });

      el.addEventListener('mouseleave', function () {
        const tooltip = document.getElementById('active-tooltip');
        if (tooltip) tooltip.remove();
      });
    });
  }


  // =====================================================
  // Active nav link highlighting
  // =====================================================
  function highlightActiveNav() {
    const path = window.location.pathname;
    document.querySelectorAll('.nav-link').forEach(function (link) {
      const href = link.getAttribute('href');
      if (href && path.startsWith(href) && href !== '/') {
        link.classList.add('text-blue-600', 'bg-blue-50');
      }
    });
  }


  // =====================================================
  // Initialize on DOM ready
  // =====================================================
  document.addEventListener('DOMContentLoaded', function () {
    initFlashMessages();
    initMobileNav();
    initUserDropdown();
    initNotificationDropdown();
    initConfirmModal();
    initPricingToggle();
    initTabs();
    initAutoResize();
    initTooltips();
    highlightActiveNav();
  });

})();

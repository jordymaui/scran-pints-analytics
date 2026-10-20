'use strict';
const status = document.getElementById('auth-status');
const signIn = document.getElementById('google-sign-in');
const messages = {
  account_not_allowed: 'This Google account does not have workshop access. Use an approved team account.',
  login_expired: 'That sign-in attempt expired. Please try again.',
  session_invalid: 'Your session has ended. Sign in again to continue.',
  sign_in_required: 'Sign in with your approved Google account to continue.',
  auth_unavailable: 'Team sign in is temporarily unavailable. Please try again shortly.',
  auth_not_configured: 'Team sign in is being set up. The public numbers and YEET report are available now.',
};
const params = new URLSearchParams(location.search);
const returnMessage = params.has('signedOut') ? 'You are signed out.' : messages[params.get('error')];
fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
  .then(async response => ({ response, data: await response.json() }))
  .then(({ response, data }) => {
    if (response.ok && data.authenticated) {
      location.replace('/workshop.html');
      return;
    }
    if (data.error === 'auth_not_configured' || response.status === 503) {
      status.textContent = messages[data.error] || messages.auth_unavailable;
      return;
    }
    signIn.disabled = false;
    status.textContent = returnMessage || 'Use your approved team Google account.';
  })
  .catch(() => { status.textContent = messages.auth_unavailable; });

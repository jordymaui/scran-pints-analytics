import {
  startGoogleLogin, finishGoogleLogin, logout, authorizeRequest, authFailure, json,
} from './auth.mjs';

const handlers = Object.freeze({
  login(req, res) {
    try { startGoogleLogin(req, res); }
    catch (error) { authFailure(res, error); }
  },
  async callback(req, res) {
    try { await finishGoogleLogin(req, res); }
    catch (error) { authFailure(res, error, { toLogin: true }); }
  },
  async logout(req, res) {
    try { await logout(req, res); }
    catch (error) { authFailure(res, error); }
  },
  async session(req, res) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return json(res, 405, { error: 'method_not_allowed' });
    }
    const user = await authorizeRequest(req, res);
    if (user) json(res, 200, { authenticated: true, user: { email: user.email } });
  },
});

export const AUTH_ACTIONS = Object.freeze(Object.keys(handlers));

// One Vercel function serves the existing auth URLs. Dispatch from the request
// path, never req.query.action: a caller's query must not select another handler.
export function createAuthDispatcher(actions = handlers) {
  return async function authDispatcher(req, res) {
    const path = String(req.url || '').split('?')[0];
    const match = /^\/api\/auth\/(login|callback|logout|session)$/.exec(path);
    if (!match || typeof actions[match[1]] !== 'function') {
      return json(res, 404, { error: 'not_found' });
    }
    return await actions[match[1]](req, res);
  };
}

export default createAuthDispatcher();

import { startGoogleLogin, authFailure } from '../../lib/auth.mjs';

export default function handler(req, res) {
  try { startGoogleLogin(req, res); }
  catch (error) { authFailure(res, error); }
}

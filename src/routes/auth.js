const express = require('express');
const { validateBody, loginSchema, refreshSchema } = require('../middleware/schemas');
const { login, refresh, revokeSession, currentUser } = require('../services/auth');
const { authenticateToken } = require('../middleware/auth');
const { verifyRefreshToken } = require('../utils/tokens');

const router = express.Router();

const meta = req => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });

router.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    res.json(await login(req.body.email, req.body.password, meta(req)));
  } catch (err) { next(err); }
});

/**
 * Who the caller is. Staff-authenticated, and the only endpoint here that is.
 *
 * A client restoring a session calls this, not /refresh -- see currentUser().
 */
router.get('/me', authenticateToken, async (req, res, next) => {
  try {
    res.json({ user: await currentUser(req.user.sub) });
  } catch (err) { next(err); }
});

router.post('/refresh', validateBody(refreshSchema), async (req, res, next) => {
  try {
    res.json(await refresh(req.body.refreshToken, meta(req)));
  } catch (err) { next(err); }
});

// Always 204: logout must not reveal whether a token was valid.
router.post('/logout', validateBody(refreshSchema), async (req, res) => {
  try {
    const claims = verifyRefreshToken(req.body.refreshToken);
    if (claims.jti) await revokeSession(claims.jti);
  } catch { /* intentionally ignored */ }
  res.status(204).end();
});

module.exports = router;

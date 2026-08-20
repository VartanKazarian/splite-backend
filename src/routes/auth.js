const express = require('express');
const {
  validateBody, loginSchema, refreshSchema, mfaChallengeSchema, mfaCodeSchema
} = require('../middleware/schemas');
const { login, completeMfaLogin, refresh, revokeSession, currentUser } = require('../services/auth');
const mfa = require('../services/mfa');
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
 * The second half of a login, for an account that has a factor.
 *
 * Unauthenticated by necessity -- the caller has no session yet, which is the
 * whole point -- and carries the challenge minted by /login. Throttled inside
 * the service on the account the challenge names.
 */
router.post('/login/mfa', validateBody(mfaChallengeSchema), async (req, res, next) => {
  try {
    res.json(await completeMfaLogin(req.body.challenge, req.body.code, meta(req)));
  } catch (err) { next(err); }
});

/**
 * Enrolment, in two steps, for the caller's own account only.
 *
 * There is no endpoint here that enrols, disables or reads the factor of
 * *another* user, including for an OWNER. A manager who could strip a
 * colleague's second factor is a manager who can take over their account, and
 * the recovery codes are what a person who genuinely lost their phone uses.
 */
router.get('/mfa', authenticateToken, async (req, res, next) => {
  try {
    res.json(await mfa.status({ userId: req.user.sub, restaurantId: req.user.restaurantId }));
  } catch (err) { next(err); }
});

router.post('/mfa/enrol', authenticateToken, async (req, res, next) => {
  try {
    const user = await currentUser(req.user.sub);
    res.status(201).json(await mfa.beginEnrolment({
      userId: req.user.sub, restaurantId: req.user.restaurantId, email: user.email
    }));
  } catch (err) { next(err); }
});

router.post('/mfa/confirm', authenticateToken, validateBody(mfaCodeSchema), async (req, res, next) => {
  try {
    res.json(await mfa.confirmEnrolment({
      userId: req.user.sub, restaurantId: req.user.restaurantId, code: req.body.code, meta: meta(req)
    }));
  } catch (err) { next(err); }
});

router.post('/mfa/disable', authenticateToken, validateBody(mfaCodeSchema), async (req, res, next) => {
  try {
    res.json(await mfa.disable({
      userId: req.user.sub, restaurantId: req.user.restaurantId, code: req.body.code, meta: meta(req)
    }));
  } catch (err) { next(err); }
});

router.post('/mfa/recovery-codes', authenticateToken, validateBody(mfaCodeSchema), async (req, res, next) => {
  try {
    res.json(await mfa.regenerateRecoveryCodes({
      userId: req.user.sub, restaurantId: req.user.restaurantId, code: req.body.code, meta: meta(req)
    }));
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

// Shared cookie-flag decisions. The auth refresh cookie and the MAL OAuth
// state cookie must agree on `secure`, or a plain-HTTP deployment (home LAN,
// no TLS yet — see app.js) with NODE_ENV=production would send a `Secure`
// cookie that browsers silently refuse to store, breaking refresh + OAuth.
import { env } from '../config/env.js';

/**
 * Whether cookies should carry the `Secure` flag. An explicit COOKIE_SECURE
 * override wins; otherwise follow NODE_ENV. Plain-HTTP deployments must set
 * COOKIE_SECURE=false.
 */
export function cookieIsSecure() {
  return env.COOKIE_SECURE !== undefined
    ? env.COOKIE_SECURE === 'true'
    : env.NODE_ENV === 'production';
}

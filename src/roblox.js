// Every call to Roblox's web API lives in this file. When Roblox changes an
// endpoint, this is the only file that should need a fix.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const COOKIE_NAME = '.ROBLOSECURITY';

class RobloxClient {
  /**
   * @param {string} cookie .ROBLOSECURITY value (may be empty for public endpoints)
   * @param {(newCookie: string) => void} [onCookieRotated] called when Roblox issues a replacement cookie
   */
  constructor(cookie, onCookieRotated) {
    this.cookie = cookie || '';
    this.onCookieRotated = onCookieRotated;
    this.csrf = '';
  }

  _captureRotation(res) {
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of setCookies) {
      if (!line.startsWith(COOKIE_NAME + '=')) continue;
      const value = line.slice(COOKIE_NAME.length + 1).split(';')[0];
      // Roblox clears the cookie with an empty value on logout; never store that.
      if (value && value !== this.cookie) {
        this.cookie = value;
        if (this.onCookieRotated) this.onCookieRotated(value);
      }
    }
  }

  async request(url, { method = 'GET', body, headers = {}, retry = true } = {}) {
    const h = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://www.roblox.com',
      Referer: 'https://www.roblox.com/',
      ...headers,
    };
    if (this.cookie) h.Cookie = `${COOKIE_NAME}=${this.cookie}`;
    if (method !== 'GET' && this.csrf) h['X-CSRF-TOKEN'] = this.csrf;
    if (body !== undefined && typeof body !== 'string') {
      body = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      // Keep it for the CSRF retry below, where body is already a string.
      headers = { ...headers, 'Content-Type': 'application/json' };
    }

    const res = await fetch(url, { method, headers: h, body, redirect: 'manual' });
    this._captureRotation(res);

    // Roblox hands out the CSRF token on a 403 for state-changing requests.
    const token = res.headers.get('x-csrf-token');
    if (res.status === 403 && token && retry) {
      this.csrf = token;
      return this.request(url, { method, body, headers, retry: false });
    }
    return res;
  }

  async json(url, opts) {
    const res = await this.request(url, opts);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const msg = data?.errors?.[0]?.message || text.slice(0, 200) || res.statusText;
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---- 2-step verification (2SV) challenges ----
  // A sensitive action (change password, display name, ...) on a 2SV-protected
  // account comes back as a 403 carrying rblx-challenge-* headers instead of
  // failing. We read the challenge, ask the caller for the code, verify it, and
  // hand back the headers to replay the original request with.

  _challenge(res) {
    const id = res.headers.get('rblx-challenge-id');
    const type = res.headers.get('rblx-challenge-type');
    const metadata = res.headers.get('rblx-challenge-metadata');
    if (res.status === 403 && id && metadata && type === 'twostepverification') return { id, metadata };
    return null;
  }

  /**
   * Solve a 2SV challenge. getCode() -> Promise<string|null> (the authenticator
   * / email code the user types). Returns headers to resend with the original
   * request, or null if the user cancelled. Throws on a wrong/expired code.
   */
  async solveTwoStep(challengeId, metadataB64, getCode) {
    const meta = JSON.parse(Buffer.from(metadataB64, 'base64').toString('utf8'));
    const code = (await getCode())?.trim();
    if (!code) return null;
    // 1) verify the code -> a one-time verification token
    const verify = await this.json(
      `https://twostepverification.roblox.com/v1/users/${meta.userId}/challenges/${meta.challengeId}/verify`,
      { method: 'POST', body: { actionType: 'Generic', challengeId: meta.challengeId, code } },
    );
    const token = verify?.verificationToken;
    if (!token) throw new Error('2-step code was not accepted');
    // 2) continue the generic challenge with that token
    const challengeMetadata = JSON.stringify({ rememberDevice: false, actionType: 'Generic', challengeId: meta.challengeId, verificationToken: token });
    await this.request('https://apis.roblox.com/challenge/v1/continue', {
      method: 'POST',
      body: { challengeId, challengeType: 'twostepverification', challengeMetadata },
    });
    // 3) headers to replay the original request, now authorised
    return {
      'rblx-challenge-id': challengeId,
      'rblx-challenge-type': 'twostepverification',
      'rblx-challenge-metadata': Buffer.from(challengeMetadata, 'utf8').toString('base64'),
    };
  }

  /** Like json(), but if the request hits a 2SV challenge it prompts via getCode and retries. */
  async jsonWithChallenge(url, opts = {}, getCode) {
    let res = await this.request(url, opts);
    const ch = this._challenge(res);
    if (ch && getCode) {
      const hdrs = await this.solveTwoStep(ch.id, ch.metadata, getCode);
      if (hdrs) res = await this.request(url, { ...opts, headers: { ...(opts.headers || {}), ...hdrs } });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const msg = data?.errors?.[0]?.message || text.slice(0, 200) || res.statusText;
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---- account ----

  /** Returns { id, name, displayName } or throws with status 401 if the cookie is dead. */
  getAuthenticatedUser() {
    return this.json('https://users.roblox.com/v1/users/authenticated');
  }

  async getRobux(userId) {
    const d = await this.json(`https://economy.roblox.com/v1/users/${userId}/currency`);
    return d?.robux ?? 0;
  }

  async getSummary(userId) {
    const [robux, friends, followers, info] = await Promise.all([
      this.getRobux(userId).catch(() => null),
      this.json(`https://friends.roblox.com/v1/users/${userId}/friends/count`).then(d => d?.count).catch(() => null),
      this.json(`https://friends.roblox.com/v1/users/${userId}/followers/count`).then(d => d?.count).catch(() => null),
      this.json(`https://users.roblox.com/v1/users/${userId}`).catch(() => null),
    ]);
    return { robux, friends, followers, created: info?.created, description: info?.description, displayName: info?.displayName };
  }

  async setDisplayName(userId, name, getCode) {
    await this.jsonWithChallenge(`https://users.roblox.com/v1/users/${userId}/display-names`, {
      method: 'PATCH',
      body: { newDisplayName: name },
    }, getCode);
    return true;
  }

  async changePassword(currentPassword, newPassword, getCode) {
    const opts = { method: 'POST', body: { currentPassword, newPassword } };
    let res = await this.request('https://auth.roblox.com/v2/user/passwords/change', opts);
    const ch = this._challenge(res);
    if (ch && getCode) {
      const hdrs = await this.solveTwoStep(ch.id, ch.metadata, getCode);
      if (hdrs) res = await this.request('https://auth.roblox.com/v2/user/passwords/change', { ...opts, headers: hdrs });
    }
    if (res.status === 200) return true;
    const text = await res.text().catch(() => '');
    let msg = text;
    try { msg = JSON.parse(text)?.errors?.[0]?.message || text; } catch { /* keep text */ }
    throw new Error(`Password change failed (${res.status}): ${msg.slice(0, 200)}`);
  }

  /** Who can join me in experiences: 'AllUsers' | 'Following' | 'Friends' | 'NoOne'. */
  async setJoinPrivacy(value, getCode) {
    await this.jsonWithChallenge('https://apis.roblox.com/user-settings-api/v1/user-settings', {
      method: 'POST',
      body: { whoCanJoinMeInExperiences: value },
    }, getCode);
    return true;
  }

  /** Invalidate this cookie's session on Roblox's side. */
  async logout() {
    const res = await this.request('https://auth.roblox.com/v2/logout', { method: 'POST', body: {} });
    if (res.status === 200) return true;
    throw new Error(`logout returned ${res.status}`);
  }

  /**
   * One-time launch ticket. Since 2026-09-23 roblox.com fetches a client
   * assertion first and posts it as the ticket request body.
   */
  async getAuthTicket() {
    const assertion = await this.json('https://auth.roblox.com/v1/client-assertion/');
    const res = await this.request('https://auth.roblox.com/v1/authentication-ticket/', {
      method: 'POST',
      body: assertion ?? {},
      headers: { Referer: 'https://www.roblox.com/', RBXAuthenticationNegotiation: '1' },
    });
    const ticket = res.headers.get('rbx-authentication-ticket');
    if (!ticket) {
      const text = await res.text().catch(() => '');
      throw new Error(`Could not get launch ticket (${res.status}) ${text.slice(0, 200)}`);
    }
    return ticket;
  }

  // ---- lookup ----

  async getUserIdByName(username) {
    const d = await this.json('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      body: { usernames: [username], excludeBannedUsers: false },
    });
    const id = d?.data?.[0]?.id;
    if (!id) throw new Error(`User "${username}" not found`);
    return id;
  }

  async getPresence(userIds) {
    if (!userIds.length) return [];
    const d = await this.json('https://presence.roblox.com/v1/presence/users', {
      method: 'POST',
      body: { userIds },
    });
    return d?.userPresences ?? [];
  }

  async getPlaceDetails(placeId) {
    const d = await this.json(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeId}`);
    return d?.[0] ?? null;
  }

  async getPlaceIcon(placeId) {
    const d = await this.json(`https://thumbnails.roblox.com/v1/places/gameicons?placeIds=${placeId}&size=150x150&format=Png&isCircular=false`);
    return d?.data?.[0]?.imageUrl ?? null;
  }

  async getAvatarHeadshots(userIds) {
    if (!userIds.length) return {};
    const out = {};
    for (let i = 0; i < userIds.length; i += 100) {
      const chunk = userIds.slice(i, i + 100).join(',');
      const d = await this.json(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${chunk}&size=48x48&format=Png&isCircular=false`);
      for (const t of d?.data ?? []) out[t.targetId] = t.imageUrl;
    }
    return out;
  }

  /** One page of public servers. */
  getServers(placeId, cursor = '', sortOrder = 'Desc') {
    const c = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    return this.json(`https://games.roblox.com/v1/games/${placeId}/servers/Public?limit=100&sortOrder=${sortOrder}&excludeFullGames=true${c}`);
  }

  /** Resolves a privateServerLinkCode from a share link into the access code the launcher needs. */
  async resolvePrivateServerLink(placeId, linkCode) {
    let url = `https://www.roblox.com/games/${placeId}?privateServerLinkCode=${encodeURIComponent(linkCode)}`;
    let res = await this.request(url, { headers: { Accept: 'text/html' } });
    for (let hops = 0; hops < 3 && res.status >= 300 && res.status < 400; hops++) {
      url = new URL(res.headers.get('location'), url).toString();
      res = await this.request(url, { headers: { Accept: 'text/html' } });
    }
    const html = await res.text();
    const m = html.match(/Roblox\.GameLauncher\.joinPrivateGame\(\d+\s*,\s*'([\w-]+)'/);
    if (!m) throw new Error('Could not read the private server access code from that link');
    return m[1];
  }

  /** Newer share links (roblox.com/share?code=...&type=Server) → { placeId, linkCode }. */
  async resolveShareLink(code) {
    const d = await this.json('https://apis.roblox.com/sharelinks/v1/resolve-link', {
      method: 'POST',
      body: { linkId: code, linkType: 'Server' },
    });
    const inv = d?.privateServerInviteData;
    if (!inv?.placeId || !inv?.linkCode) throw new Error('That share link is not a valid private server invite');
    return { placeId: inv.placeId, linkCode: inv.linkCode };
  }
}

module.exports = { RobloxClient, COOKIE_NAME, UA };

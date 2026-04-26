const axios = require('axios');

function required(name, value) {
  if (!value) throw new Error(`Missing Keycloak config: ${name}`);
  return value;
}

function keycloakClient({ keycloak }) {
  const baseUrl = required('KEYCLOAK_BASE_URL', keycloak?.baseUrl);
  const realm = required('KEYCLOAK_REALM', keycloak?.realm);
  const adminClientId = required('KEYCLOAK_ADMIN_CLIENT_ID', keycloak?.adminClientId);
  const adminClientSecret = required('KEYCLOAK_ADMIN_CLIENT_SECRET', keycloak?.adminClientSecret);

  const tokenUrl = `${baseUrl}/realms/${realm}/protocol/openid-connect/token`;
  const adminBase = `${baseUrl}/admin/realms/${realm}`;
  const issuer = `${baseUrl}/realms/${realm}`;
  const jwksUrl = `${baseUrl}/realms/${realm}/protocol/openid-connect/certs`;

  let cachedAdminToken;
  let cachedAdminTokenExpMs = 0;

  async function getAdminToken() {
    const now = Date.now();
    if (cachedAdminToken && cachedAdminTokenExpMs - now > 15_000) return cachedAdminToken;

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', adminClientId);
    body.set('client_secret', adminClientSecret);

    const resp = await axios.post(tokenUrl, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    });

    cachedAdminToken = resp.data.access_token;
    const expiresIn = Number(resp.data.expires_in || 60);
    cachedAdminTokenExpMs = now + expiresIn * 1000;
    return cachedAdminToken;
  }

  async function adminRequest(method, path, { params, data } = {}) {
    const token = await getAdminToken();
    return axios.request({
      method,
      url: `${adminBase}${path}`,
      params,
      data,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10_000,
    });
  }

  async function findUserByUsername(username) {
    const resp = await adminRequest('GET', '/users', { params: { username, exact: true } });
    return Array.isArray(resp.data) ? resp.data[0] || null : null;
  }

  async function findUserByEmail(email) {
    const resp = await adminRequest('GET', '/users', { params: { email: email.toLowerCase() } });
    return Array.isArray(resp.data) ? resp.data[0] || null : null;
  }

  async function createUser({ username, email, firstName, lastName, enabled = true, emailVerified = false, attributes = {} }) {
    const resp = await adminRequest('POST', '/users', {
      data: {
        username,
        email,
        firstName,
        lastName,
        enabled,
        emailVerified,
        attributes,
      },
    });

    // Keycloak returns 201 with Location header containing the created ID.
    const loc = resp.headers?.location || resp.headers?.Location;
    if (loc && String(loc).includes('/users/')) {
      const id = String(loc).split('/users/')[1];
      return id || null;
    }

    // Fallback: fetch it.
    const u = await findUserByUsername(username);
    return u?.id || null;
  }

  async function executeActionsEmail(userId, actions, { lifespanSeconds } = {}) {
    const params = {};
    if (keycloak?.actionsClientId) params.client_id = keycloak.actionsClientId;
    if (keycloak?.actionsRedirectUri) params.redirect_uri = keycloak.actionsRedirectUri;
    if (lifespanSeconds) params.lifespan = Number(lifespanSeconds);

    await adminRequest('PUT', `/users/${encodeURIComponent(userId)}/execute-actions-email`, {
      params,
      data: actions,
    });
  }

  async function setUserEnabled(userId, enabled) {
    await adminRequest('PUT', `/users/${encodeURIComponent(userId)}`, {
      data: { enabled: Boolean(enabled) },
    });
  }

  async function getUser(userId) {
    const resp = await adminRequest('GET', `/users/${encodeURIComponent(userId)}`);
    return resp.data;
  }

  async function updateUser(userId, data) {
    await adminRequest('PUT', `/users/${encodeURIComponent(userId)}`, { data });
  }

  return {
    baseUrl,
    realm,
    issuer,
    jwksUrl,
    tokenUrl,
    getAdminToken,
    findUserByUsername,
    findUserByEmail,
    createUser,
    executeActionsEmail,
    setUserEnabled,
    getUser,
    updateUser,
  };
}

module.exports = { keycloakClient };

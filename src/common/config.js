function required(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function getConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';

  const portalPort = Number(process.env.PORTAL_PORT || process.env.PORT || 3000);
  const sarmsPort = Number(process.env.SARMS_PORT || 3001);

  const sarmsBaseUrl = process.env.SARMS_BASE_URL || `http://localhost:${sarmsPort}`;

  const dbEnabled = String(process.env.DB_ENABLED || 'true').toLowerCase() !== 'false';
  const db = {
    enabled: dbEnabled,
    user: process.env.ORACLE_USER,
    password: process.env.ORACLE_PASSWORD,
    connectString: process.env.ORACLE_CONNECT_STRING || process.env.ORACLE_CONNECTSTRING,
  };

  const smtp = {
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'noreply@club.local',
  };

  const stripe = {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    currency: process.env.STRIPE_CURRENCY || 'bwp',
    // Stripe expects the smallest currency unit (e.g. cents). P100 => 10000.
    unitAmount: process.env.STRIPE_UNIT_AMOUNT ? Number(process.env.STRIPE_UNIT_AMOUNT) : 10000,
  };

  const keycloak = {
    baseUrl: process.env.KEYCLOAK_BASE_URL,
    realm: process.env.KEYCLOAK_REALM,
    // Service account client (used by the Portal to call the Keycloak Admin API)
    adminClientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID,
    adminClientSecret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET,
    // Optional values used by execute-actions-email links.
    actionsClientId: process.env.KEYCLOAK_ACTIONS_CLIENT_ID,
    actionsRedirectUri: process.env.KEYCLOAK_ACTIONS_REDIRECT_URI,
  };

  return {
    nodeEnv,
    portalPort,
    sarmsPort,
    sarmsBaseUrl,
    db,
    smtp,
    stripe,
    keycloak,
  };
}

module.exports = { required, getConfig };

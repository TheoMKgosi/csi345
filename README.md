# csi345

Backend-only implementation for a university club portal + a separate SARMS API.

## Services

- Portal API: `src/portal/server.js` (default port `3000`)
- SARMS API: `src/sarms/server.js` (default port `3001`)

## Setup

1) Install deps

```bash
npm install
```

2) Create Oracle schema

- Run `sql/schema.sql` in your Oracle database.

3) Configure env

Create a `.env` file:

```bash
ORACLE_USER=...
ORACLE_PASSWORD=...
ORACLE_CONNECT_STRING=localhost/FREEPDB1

PORTAL_PORT=3000
SARMS_PORT=3001
SARMS_BASE_URL=http://localhost:3001

# Keycloak (IAM)
KEYCLOAK_BASE_URL=http://localhost:8080
KEYCLOAK_REALM=club
KEYCLOAK_ADMIN_CLIENT_ID=portal-admin
KEYCLOAK_ADMIN_CLIENT_SECRET=...

# Optional: used when Keycloak sends action emails
KEYCLOAK_ACTIONS_CLIENT_ID=
KEYCLOAK_ACTIONS_REDIRECT_URI=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_CURRENCY=bwp
# P100 in the smallest unit (e.g. thebe/cents). Default is 10000.
STRIPE_UNIT_AMOUNT=10000

# Optional SMTP (emails log to console if unset)
SMTP_HOST=
SMTP_PORT=
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@club.local
```

## Run

In two terminals:

```bash
npm run start:sarms
```

```bash
npm run start:portal
```

Health checks:

- `GET http://localhost:3001/health`
- `GET http://localhost:3000/health`

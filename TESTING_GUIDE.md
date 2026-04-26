# Testing Guide (All Requirements)

This guide assumes Oracle is running and `sql/schema.sql` has been applied.

## 1. Start Services

In two terminals:

- `npm run start:sarms`
- `npm run start:portal`

Health checks:

- `GET http://localhost:3001/health`
- `GET http://localhost:3000/health`

## 2. Seed Data

Run these in Oracle (SQL*Plus / SQL Developer):

- `sql/seed_sarms.sql`
- `sql/seed_portal.sql`

Student IDs seeded follow the 9-digit format (example: `202201557`).

## 3. SARMS Validation (Must Reject Mismatch / Not Found)

### 3.1 Valid student (should pass SARMS)

Call Portal registration:

`POST http://localhost:3000/register/validate`

Body:

```json
{
  "studentId": 202201557,
  "name": "Thato Mokoena",
  "dob": "2003-04-19",
  "email": "202201557@university.ac.bw",
  "phoneNumber": "71234567"
}
```

Expected:

- `200 { "ok": true }`

Notes:

- This also creates the user in Keycloak and triggers required-actions email.
- If Keycloak is not configured, you will get `501 keycloak not configured`.

### 3.2 Mismatch details (should fail)

Use correct studentId but wrong DOB/name.

Expected:

- `403 { "error": "SARMS validation failed" }`

### 3.3 Not found student (should fail)

Use a non-existent studentId.

Expected:

- `403 { "error": "SARMS validation failed" }`

## 4. Account Verification, Password Reset, and OTP 2FA (Keycloak)

These are handled by Keycloak:

1. Verify Email: Keycloak sends the verify email link.
2. Set Password: Keycloak required action `UPDATE_PASSWORD`.
3. Configure OTP: Keycloak required action `CONFIGURE_TOTP`.
4. Password reset: use Keycloak “Forgot password” workflow.

Direct login (API) uses Keycloak token endpoint:

- `POST {KEYCLOAK_BASE_URL}/realms/{realm}/protocol/openid-connect/token`
- `grant_type=password`
- `username=<studentId>`
- `password=<keycloak password>`

## 5. Pay Annual Fee (Stripe)

Create a checkout session:

`POST http://localhost:3000/payments/checkout-session`

```json
{
  "studentId": 202201557,
  "successUrl": "http://localhost:3000/payment-success",
  "cancelUrl": "http://localhost:3000/payment-cancel"
}
```

Expected:

- `201` with `sessionId` and `url`.

Stripe will call:

- `POST http://localhost:3000/payments/webhooks/stripe`

On `checkout.session.completed` (paid), Portal will:

- Insert `Payment`
- Insert 12-month `Membership`
- Set `Student.status = ACTIVE`
- Re-enable Keycloak user (best-effort)

## 6. Membership Status + Card

### 6.1 Status

`GET http://localhost:3000/members/202201557/status`

Expected:

- `200` with `status` and latest `membership` (or `membership: null` if none).

### 6.2 Card

`GET http://localhost:3000/cards/generate/202201557`

Expected:

- `200` PDF

## 7. Book Equipment (No Overlaps)

### 7.1 List equipment

`GET http://localhost:3000/equipment`

Pick an `equipmentId`.

### 7.2 Create booking

`POST http://localhost:3000/bookings`

```json
{
  "equipmentId": 1,
  "studentId": 202201557,
  "startTime": "2026-04-07T10:00:00",
  "endTime": "2026-04-07T11:00:00"
}
```

Expected:

- `201 { "ok": true }`

### 7.3 Overlap attempt

Create another booking with overlapping time window.

Expected:

- `409 { "error": "time slot already taken" }`

## 8. Booking Reminder (2 Hours Before)

The scheduler runs the reminder job every minute.

To test quickly, insert a booking with `startTime` about 2 hours from now.
The job looks for bookings between ~1h55 and ~2h05 from current time.

Email behavior:

- If SMTP is not configured, emails are logged to console as `[email:dev]`.

## 9. Renewal Reminder (2 Months Before)

The scheduler runs daily at 01:05.

It selects memberships with latest `expireDate` between `SYSDATE + 60` and `SYSDATE + 62` and `renewalRemindedAt IS NULL`.

To test, set a membership expire date into that window and wait for the job run, or run the SQL manually and watch the console email logs.

## 10. Auto-Block on Expiry + Disable Keycloak User

The scheduler runs daily at 01:05.

It will:

1. Set `Student.status = BLOCKED` for students whose latest membership is expired.
2. Disable the Keycloak user (best-effort) using `Student.keycloakUserId` or username lookup.

## 11. Blocked Users Renewal

### 11.1 Initiate renewal

`POST http://localhost:3000/members/renew`

```json
{ "email": "202201557@university.ac.bw" }
```

Expected:

- `200 { "ok": true }` and an email containing a renewal link (dev logs if no SMTP).

### 11.2 Confirm renewal (optional flow)

`POST http://localhost:3000/members/renew/confirm`

```json
{
  "token": "<token from renewal email>",
  "transactionRef": "manual-renewal-202201557",
  "amount": 100
}
```

Expected:

- `200 { "ok": true }`

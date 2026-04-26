const express = require('express');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');

const { query, execute, transaction } = require('../common/db');
const { sendEmail } = require('../common/email');
const { addMinutes, randomToken, toIsoDate } = require('../common/utils');

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

  async function createUser({ username, email, enabled = true, emailVerified = false, attributes = {} }) {
    const resp = await adminRequest('POST', '/users', {
      data: {
        username,
        email,
        enabled,
        emailVerified,
        attributes,
      },
    });

    const loc = resp.headers?.location || resp.headers?.Location;
    if (loc && String(loc).includes('/users/')) {
      const id = String(loc).split('/users/')[1];
      return id || null;
    }

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
    await adminRequest('PUT', `/users/${encodeURIComponent(userId)}`,
      {
        data: { enabled: Boolean(enabled) },
      }
    );
  }

  async function getUser(userId) {
    const resp = await adminRequest('GET', `/users/${encodeURIComponent(userId)}`);
    return resp.data;
  }

  return {
    baseUrl,
    realm,
    tokenUrl,
    getAdminToken,
    findUserByUsername,
    createUser,
    executeActionsEmail,
    setUserEnabled,
    getUser,
  };
}

function portalApp({ config }) {
  const app = express();

  let kc;
  try {
    kc = keycloakClient({ keycloak: config.keycloak });
  } catch (e) {
    kc = null;
  }

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'portal' });
  });

  // Stripe webhooks require raw body for signature verification.
  // Note: this route must be registered before express.json().

  // Stripe webhooks require raw body for signature verification.
  app.post('/payments/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log('stripe webhook');
    if (!config?.stripe?.webhookSecret) {
      return res.status(501).json({ error: 'stripe webhook not configured' });
    }
    const sig = req.header('stripe-signature');
    if (!sig) return res.status(400).json({ error: 'missing Stripe-Signature' });

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
    const payload = rawBody.toString('utf8');

    // Verify signature: https://stripe.com/docs/webhooks#verify-signatures
    const parts = String(sig)
      .split(',')
      .map((p) => p.trim());
    const tPart = parts.find((p) => p.startsWith('t='));
    const v1Parts = parts.filter((p) => p.startsWith('v1='));
    if (!tPart || !v1Parts.length) return res.status(400).json({ error: 'invalid Stripe-Signature format' });

    const timestamp = tPart.slice(2);
    const signedPayload = `${timestamp}.${payload}`;
    const expected = crypto
      .createHmac('sha256', config.stripe.webhookSecret)
      .update(signedPayload)
      .digest('hex');

    const ok = v1Parts.some((p) => {
      const actual = p.slice(3);
      try {
        return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
      } catch (_) {
        return false;
      }
    });

    if (!ok) {
      console.log('[stripe-webhook] Invalid signature. sig:', sig.substring(0, 50), '... expected:', expected);
      return res.status(400).json({ error: 'invalid signature' });
    }

    let event;
    try {
      event = JSON.parse(payload);
    } catch (_) {
      return res.status(400).json({ error: 'invalid json' });
    }

    // Handle successful payments and activate membership.
    if (event?.type === 'checkout.session.completed') {
      console.log('[stripe-webhook] checkout.session.completed event received');
      const session = event?.data?.object || {};
      const paymentStatus = session.payment_status;
      const studentIdRaw = session?.metadata?.studentId || session?.client_reference_id;
      const studentId = studentIdRaw ? Number(studentIdRaw) : NaN;
      const transactionRef = session.id;
      const amountTotal = session.amount_total;

      console.log('[stripe-webhook] paymentStatus:', paymentStatus, 'studentId:', studentId, 'transactionRef:', transactionRef, 'amountTotal:', amountTotal);

      console.log('[stripe-webhook] Checking conditions:');
      console.log('  paymentStatus === "paid":', paymentStatus === 'paid');
      console.log('  transactionRef:', !!transactionRef);
      console.log('  !Number.isNaN(studentId):', !Number.isNaN(studentId));
      console.log('  amountTotal != null:', amountTotal != null);

      if (paymentStatus === 'paid' && transactionRef && !Number.isNaN(studentId) && amountTotal != null) {
        console.log('[stripe-webhook] All conditions met, processing payment...');
        const truncatedRef = String(transactionRef).substring(0, 50);
        const amount = Number(amountTotal) / 100;
        try {
          await transaction(async (conn) => {
            await conn.execute(
              `INSERT INTO Payment (transactionRef, amount, studentID)
               VALUES (:transactionRef, :amount, :studentId)`,
              { transactionRef: truncatedRef, amount, studentId },
              { autoCommit: false }
            );

            const pRows = await conn.execute(
              `SELECT paymentID AS "paymentId" FROM Payment WHERE transactionRef = :transactionRef`,
              { transactionRef: truncatedRef },
              { autoCommit: false }
            );
            const paymentId =
              pRows.rows?.[0]?.paymentId ??
              pRows.rows?.[0]?.PAYMENTID ??
              // When outFormat is ARRAY (default for conn.execute)
              pRows.rows?.[0]?.[0];
            if (!paymentId) throw new Error('payment insert failed');

            const issueDate = new Date();
            await conn.execute(
              `INSERT INTO Membership (issueDate, expireDate, paymentID, studentID)
               VALUES (:issueDate, ADD_MONTHS(:issueDate, 12), :paymentId, :studentId)`,
              { issueDate, paymentId: Number(paymentId), studentId },
              { autoCommit: false }
            );

            await conn.execute(
              `UPDATE Student SET status = 'ACTIVE' WHERE studentID = :studentId`,
              { studentId },
              { autoCommit: false }
            );
            console.log('[stripe-webhook] Student status update executed for studentId:', studentId);
            console.log('[stripe-webhook] Checking if status actually changed...');
          });

          // Verify the status change
          const verifyRows = await query(`SELECT status FROM Student WHERE studentID = :studentId`, { studentId });
          console.log('[stripe-webhook] Verified status after update:', verifyRows[0]?.status);

          // If Keycloak is configured, re-enable the IAM user (best-effort).
          if (kc) {
            console.log('[stripe-webhook] Attempting to enable Keycloak user for studentId:', studentId);
            try {
              const sRows = await query(`SELECT keycloakUserId FROM Student WHERE studentID = :studentId`, { studentId });
              const userId = sRows[0]?.keycloakUserId || sRows[0]?.KEYCLOAKUSERID || null;
              if (userId) {
                await kc.setUserEnabled(String(userId), true);
              } else {
                const u = await kc.findUserByUsername(String(studentId));
                if (u?.id) await kc.setUserEnabled(String(u.id), true);
              }
            } catch (e2) {
              console.error('Keycloak enable failed:', e2.message);
            }
          }
        } catch (e) {
          // Duplicate transactionRef (replayed webhook): treat as success.
          if (String(e.message || '').includes('ORA-00001') || String(e.message || '').includes('unique')) {
            // ignore
          } else {
            console.error('Stripe webhook processing error:', e);
            return res.status(500).json({ error: 'internal error' });
          }
        }
      }
    } else {
      console.log('[stripe-webhook] Unhandled event type:', event?.type);
      console.log('[stripe-webhook] Full event:', JSON.stringify(event, null, 2).substring(0, 500));
    }

    console.log('[stripe-webhook] Sending response');
    res.json({ ok: true });
  });

  app.use(express.json());

  async function createNotification({ studentId, type, message, channel, to }) {
    const createdAt = new Date();
    return execute(
      `INSERT INTO Notification (type, message, channel, studentID, recipient, status, createdAt)
       VALUES (:type, :message, :channel, :studentId, :recipient, :status, :createdAt)`,
      {
        type,
        message,
        channel: channel || 'email',
        studentId: studentId || null,
        recipient: to || null,
        status: 'queued',
        createdAt,
      }
    );
  }

  // =========================
  // Membership Service
  // =========================
  app.post('/register/validate', async (req, res) => {
    const { studentId, name, dob, email, phoneNumber } = req.body || {};
    if (!String(studentId || '').match(/^\d{9}$/)) {
      console.warn('[register/validate] invalid studentId format', { studentId });
      return res.status(400).json({ error: 'studentId must be a 9-digit number' });
    }
    if (!studentId || !name || !dob || !email) {
      console.warn('[register/validate] missing required fields', {
        hasStudentId: Boolean(studentId),
        hasName: Boolean(name),
        hasDob: Boolean(dob),
        hasEmail: Boolean(email),
      });
      return res.status(400).json({ error: 'studentId, name, dob, email required' });
    }

    // Verify with SARMS: studentID + name + DOB
    try {
      await axios.post(`${config.sarmsBaseUrl}/sarms/verify`, { studentId, name, dob }, { timeout: 5000 });
    } catch (e) {
      if (e.response && (e.response.status === 403 || e.response.status === 404)) {
        console.warn('[register/validate] SARMS validation failed', {
          studentId,
          status: e.response.status,
          data: e.response.data,
        });
        const data = e.response.data || {};
        const reason = data.reason || (e.response.status === 404 ? 'not_found' : 'mismatch');
        const mismatches = Array.isArray(data.mismatches) ? data.mismatches : null;
        return res.status(403).json({ error: 'SARMS validation failed', reason, mismatches });
      }
      console.error('[register/validate] SARMS unavailable/error', {
        studentId,
        message: e.message,
      });
      return res.status(502).json({ error: 'SARMS unavailable' });
    }

    if (!kc) {
      console.error('[register/validate] keycloak not configured');
      return res.status(501).json({ error: 'keycloak not configured' });
    }

    // Create Keycloak user: username == studentId
    let userId;
    const nameParts = String(name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';
    try {
      userId = await kc.createUser({
        username: String(studentId),
        email: String(email),
        firstName,
        lastName,
        enabled: true,
        emailVerified: false,
        attributes: { studentId: String(studentId) },
      });
    } catch (e) {
      if (e.response?.status === 409) return res.status(409).json({ error: 'user already exists in keycloak' });
      console.error('[register/validate] Keycloak create user failed', {
        studentId,
        message: e.message,
        status: e.response?.status,
        data: e.response?.data,
      });
      return res.status(502).json({ error: 'keycloak unavailable' });
    }

    // Insert student record (name/email in Keycloak).
    try {
      await execute(
        `INSERT INTO Student (studentID, DOB, phoneNumber, keycloakUserId, status)
         VALUES (:studentId, TO_DATE(:dob,'YYYY-MM-DD'), :phoneNumber, :keycloakUserId, :status)`,
        {
          studentId: Number(studentId),
          dob,
          phoneNumber: phoneNumber || null,
          keycloakUserId: userId || null,
          status: 'PENDING_PAYMENT',
        }
      );
    } catch (e) {
      if (String(e.message || '').includes('unique') || String(e.message || '').includes('ORA-00001')) {
        console.warn('[register/validate] student already exists (db unique)', { studentId, email });
        return res.status(409).json({ error: 'student already exists' });
      }
      console.error('[register/validate] DB insert failed', { studentId, message: e.message });
      throw e;
    }

    // Trigger Keycloak emails: verify email, set password, configure OTP.
    try {
      await kc.executeActionsEmail(String(userId), ['VERIFY_EMAIL', 'UPDATE_PASSWORD', 'CONFIGURE_TOTP'], {
        lifespanSeconds: 60 * 60 * 24,
      });
    } catch (e) {
      console.error('[register/validate] Keycloak execute-actions-email failed', {
        studentId,
        userId,
        message: e.message,
        status: e.response?.status,
        data: e.response?.data,
      });
    }

    res.status(200).json({ ok: true });
  });

  app.get('/members/:studentId/status', async (req, res) => {
    const studentId = Number(req.params.studentId);
    const rows = await query(
       `SELECT s.studentID AS "studentId",
              s.status AS "status",
              TO_CHAR(m.issueDate,'YYYY-MM-DD') AS "issueDate",
              TO_CHAR(m.expireDate,'YYYY-MM-DD') AS "expireDate"
       FROM Student s
       LEFT JOIN (
         SELECT studentID, issueDate, expireDate
         FROM (
           SELECT studentID, issueDate, expireDate,
                  ROW_NUMBER() OVER (PARTITION BY studentID ORDER BY issueDate DESC, memberID DESC) AS rn
           FROM Membership
         )
         WHERE rn = 1
       ) m ON m.studentID = s.studentID
       WHERE s.studentID = :studentId`,
      { studentId }
    );
    if (!rows.length) return res.status(404).json({ error: 'student not found' });
    const r = rows[0];
    const membership = r.issueDate ? { issueDate: r.issueDate, expireDate: r.expireDate } : null;
    res.json({ studentId: r.studentId, status: r.status, membership });
  });

  app.patch('/members/:studentId/status', async (req, res) => {
    const studentId = Number(req.params.studentId);
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status required' });
    const result = await execute(`UPDATE Student SET status = :status WHERE studentID = :studentId`, { status, studentId });
    if (!result.rowsAffected) return res.status(404).json({ error: 'student not found' });
    res.json({ ok: true });
  });

app.post('/members/renew', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  let studentId = null;
  try {
    const kcUser = await kc.findUserByEmail(email);
    if (kcUser?.id) {
      const rows = await query(`SELECT studentID FROM Student WHERE keycloakUserId = :userId`, { userId: kcUser.id });
      if (rows.length) studentId = Number(rows[0].studentID || rows[0].STUDENTID);
    }
  } catch (e) {
    console.error('[members/renew] keycloak lookup failed', { email, message: e.message });
  }
  if (!studentId) return res.json({ ok: true });
    const token = randomToken(24);
    const expiresAt = addMinutes(new Date(), 60 * 24 * 3); // 3 days
    await execute(
      `INSERT INTO RenewalToken (studentID, token, expiresAt) VALUES (:studentId, :token, :expiresAt)`,
      { studentId, token, expiresAt }
    );

    const link = `${config.portalBaseUrl || `http://localhost:${config.portalPort}`}/renew-membership?token=${token}`;
    const text = `Renew your membership using this link: ${link}`;
    await createNotification({ studentId, type: 'membership_renewal', message: text, channel: 'email', to: email });
    await sendEmail({ smtp: config.smtp, to: email, subject: 'Membership renewal', text });
    res.json({ ok: true });
  });

  app.post('/members/renew/confirm', async (req, res) => {
    const { token, transactionRef, amount } = req.body || {};
    if (!token || !transactionRef) return res.status(400).json({ error: 'token, transactionRef required' });

    const rows = await query(
      `SELECT id, studentID AS "studentId", expiresAt, usedAt FROM RenewalToken WHERE token = :token`,
      { token }
    );
    if (!rows.length) return res.status(404).json({ error: 'invalid token' });
    const t = rows[0];
    if (t.USEDAT || t.usedAt) return res.status(409).json({ error: 'token already used' });
    const expiresAt = new Date(t.EXPIRESAT || t.expiresAt);
    if (expiresAt.getTime() < Date.now()) return res.status(410).json({ error: 'token expired' });

    const studentId = Number(t.studentId || t.STUDENTID);
    const amt = amount !== undefined ? Number(amount) : 100;

    try {
      await transaction(async (conn) => {
        await conn.execute(
          `INSERT INTO Payment (transactionRef, amount, studentID)
           VALUES (:transactionRef, :amount, :studentId)`,
          { transactionRef: String(transactionRef), amount: amt, studentId },
          { autoCommit: false }
        );
        const pRows = await conn.execute(
          `SELECT paymentID AS "paymentId" FROM Payment WHERE transactionRef = :transactionRef`,
          { transactionRef: String(transactionRef) },
          { autoCommit: false }
        );
        const paymentId =
          pRows.rows?.[0]?.paymentId ??
          pRows.rows?.[0]?.PAYMENTID ??
          // When outFormat is ARRAY (default for conn.execute)
          pRows.rows?.[0]?.[0];
        if (!paymentId) throw new Error('payment insert failed');

        const issueDate = new Date();
        await conn.execute(
          `INSERT INTO Membership (issueDate, expireDate, paymentID, studentID)
           VALUES (:issueDate, ADD_MONTHS(:issueDate, 12), :paymentId, :studentId)`,
          { issueDate, paymentId: Number(paymentId), studentId },
          { autoCommit: false }
        );
        await conn.execute(
          `UPDATE Student SET status = 'ACTIVE' WHERE studentID = :studentId`,
          { studentId },
          { autoCommit: false }
        );
        await conn.execute(
          `UPDATE RenewalToken SET usedAt = :usedAt WHERE id = :id`,
          { usedAt: new Date(), id: t.ID || t.id },
          { autoCommit: false }
        );
      });
    } catch (e) {
      if (String(e.message || '').includes('ORA-00001') || String(e.message || '').includes('unique')) {
        return res.status(409).json({ error: 'transactionRef already used' });
      }
      throw e;
    }

    // If Keycloak is configured, re-enable the IAM user.
    if (kc) {
      try {
        const sRows = await query(`SELECT keycloakUserId FROM Student WHERE studentID = :studentId`, { studentId });
        const userId = sRows[0]?.keycloakUserId || sRows[0]?.KEYCLOAKUSERID || null;
        if (userId) {
          await kc.setUserEnabled(String(userId), true);
        } else {
          const u = await kc.findUserByUsername(String(studentId));
          if (u?.id) await kc.setUserEnabled(String(u.id), true);
        }
      } catch (e2) {
        console.error('Keycloak enable failed:', e2.message);
      }
    }

    res.json({ ok: true });
  });

app.get('/cards/generate/:studentId', async (req, res) => {
  const studentId = Number(req.params.studentId);
  const sRows = await query(`SELECT keycloakUserId FROM Student WHERE studentID = :studentId`, { studentId });
  if (!sRows.length) return res.status(404).json({ error: 'student not found' });

  const userId = sRows[0]?.keycloakUserId || sRows[0]?.KEYCLOAKUSERID || null;
  if (!userId) return res.status(400).json({ error: 'keycloak user not linked' });

  let name = '', email = '';
  try {
    const kcUser = await kc.getUser(userId);
    name = kcUser?.firstName && kcUser?.lastName 
      ? `${kcUser.firstName} ${kcUser.lastName}` 
      : kcUser?.username || '';
    email = kcUser?.email || '';
  } catch (e) {
    console.error('[cards/generate] failed to get keycloak user', { studentId, userId, message: e.message });
  }

  const mRows = await query(
    `SELECT issueDate, expireDate FROM Membership WHERE studentID = :studentId
     ORDER BY issueDate DESC FETCH FIRST 1 ROWS ONLY`,
    { studentId }
  );
  if (!mRows.length) return res.status(404).json({ error: 'no membership found' });
  const issueDate = new Date(mRows[0].ISSUEDATE || mRows[0].issueDate);
  const expireDate = new Date(mRows[0].EXPIREDATE || mRows[0].expireDate);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="membership-card-${studentId}.pdf"`);

  const doc = new PDFDocument({ size: [264, 165], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  doc.pipe(res);

  const cardWidth = 264;
  const cardHeight = 165;
  const primaryColor = '#1a365d';
  const accentColor = '#c53030';
  const lightBg = '#f7fafc';

  doc.rect(0, 0, cardWidth, cardHeight).fill('#e2e8f0');
  doc.rect(2, 2, cardWidth - 4, cardHeight - 4).fill('#ffffff');
  doc.rect(2, 2, cardWidth - 4, 55).fill(primaryColor);

  doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold').text('UNIVERSITY CLUB', 12, 18, { align: 'center', width: cardWidth - 24 });
  doc.fontSize(8).font('Helvetica').text('MEMBERSHIP CARD', 12, 34, { align: 'center', width: cardWidth - 24 });

  doc.rect(cardWidth - 50, 10, 38, 38).fill(primaryColor).stroke('#ffffff');
  doc.fillColor('#ffffff').fontSize(6).font('Helvetica-Bold').text('UNIV', cardWidth - 48, 20, { align: 'center', width: 34 });
  doc.fontSize(10).text('CLUB', cardWidth - 48, 30, { align: 'center', width: 34 });

  doc.fillColor('#1a365d').fontSize(11).font('Helvetica-Bold').text(name, 16, 65, { width: cardWidth - 32 });
  doc.fillColor('#4a5568').fontSize(9).font('Helvetica').text(`Student ID: ${studentId}`, 16, 82, { width: cardWidth - 32 });

  doc.fillColor('#718096').fontSize(7).font('Helvetica').text(email, 16, 95, { width: cardWidth - 32, max: 1 });

  doc.rect(16, 115, cardWidth - 32, 1).fill('#e2e8f0');

  doc.fillColor('#1a365d').fontSize(8).font('Helvetica-Bold').text('MEMBERSHIP PERIOD', 16, 122);
  doc.fillColor('#4a5568').fontSize(9).font('Helvetica').text(`${toIsoDate(issueDate)} — ${toIsoDate(expireDate)}`, 16, 136);

  const daysRemaining = Math.ceil((expireDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const isValid = daysRemaining > 0;
  
  if (daysRemaining < 0) {
    doc.fillColor('#c53030').fontSize(8).font('Helvetica-Bold').text('EXPIRED', cardWidth - 70, 122);
  } else if (daysRemaining < 30) {
    doc.fillColor('#d69e2e').fontSize(8).font('Helvetica-Bold').text(`${daysRemaining} DAYS LEFT`, cardWidth - 80, 122);
  } else {
    doc.fillColor('#38a169').fontSize(8).font('Helvetica-Bold').text('ACTIVE', cardWidth - 60, 122);
  }

  doc.fillColor('#c53030').fontSize(6).font('Helvetica').text('Non-transferable', 16, 152);
  doc.fillColor('#718096').fontSize(5).font('Helvetica').text('Use as ID for club access', 16, 160);

  doc.end();
});

  // =====================
  // Payments (Stripe)
  // =====================
  app.get('/payment-success', (req, res) => {
    res.json({ ok: true, message: 'Payment successful' });
  });

  app.get('/payment-cancel', (req, res) => {
    res.json({ ok: false, message: 'Payment cancelled' });
  });

  app.post('/payments/checkout-session', async (req, res) => {
    console.log('checkout session');
    if (!config?.stripe?.secretKey) {
      return res.status(501).json({ error: 'stripe not configured' });
    }

    const { studentId, successUrl, cancelUrl } = req.body || {};
    if (!studentId) return res.status(400).json({ error: 'studentId required' });

const sRows = await query(`SELECT keycloakUserId, status FROM Student WHERE studentID = :studentId`, { studentId: Number(studentId) });
  if (!sRows.length) return res.status(404).json({ error: 'student not found' });

  const s = sRows[0];
  const status = String(s.status || '').toUpperCase();
  if (status === 'BLOCKED') return res.status(403).json({ error: 'account blocked' });

  const userId = s.keycloakUserId || s.KEYCLOAKUSERID;
  if (!userId) return res.status(400).json({ error: 'keycloak user not linked' });

  let email = '';
  try {
    const kcUser = await kc.getUser(userId);
    email = kcUser?.email || '';
  } catch (e) {
    console.error('[membership/purchase] failed to get keycloak user', { studentId, userId, message: e.message });
  }
  if (!email) return res.status(400).json({ error: 'student email missing' });

    const mRows = await query(
      `SELECT memberID, expireDate FROM Membership
       WHERE studentID = :studentId AND expireDate >= SYSDATE
       ORDER BY expireDate DESC FETCH FIRST 1 ROWS ONLY`,
      { studentId: Number(studentId) }
    );
    if (mRows.length) {
      const expireDate = new Date(mRows[0].EXPIREDATE || mRows[0].expireDate);
      return res.status(409).json({ error: 'student already has a valid membership', expireDate });
    }
    console.log('membership added')

    // Email verification is enforced by Keycloak (not by this service).

    const okSuccess = successUrl || `${config.portalBaseUrl || `http://localhost:${config.portalPort}`}/payment-success`;
    const okCancel = cancelUrl || `${config.portalBaseUrl || `http://localhost:${config.portalPort}`}/payment-cancel`;

    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('success_url', okSuccess);
    params.set('cancel_url', okCancel);
    params.set('client_reference_id', String(studentId));
    params.set('customer_email', String(email));
    params.set('metadata[studentId]', String(studentId));
    params.set('metadata[purpose]', 'membership');

    params.set('line_items[0][quantity]', '1');
    params.set('line_items[0][price_data][currency]', String(config.stripe.currency || 'bwp'));
    params.set('line_items[0][price_data][unit_amount]', String(Number(config.stripe.unitAmount || 10000)));
    params.set('line_items[0][price_data][product_data][name]', 'Annual membership fee');

    let resp;
    try {
      resp = await axios.post('https://api.stripe.com/v1/checkout/sessions', params.toString(), {
        headers: {
          Authorization: `Bearer ${config.stripe.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      });
    } catch (e) {
      const msg = e.response?.data?.error?.message || 'stripe error';
      return res.status(502).json({ error: msg });
    }

    res.status(201).json({ sessionId: resp.data.id, url: resp.data.url });
  });

  // =====================
  // Booking Service
  // =====================
  app.get('/bookings', async (req, res) => {
    const rows = await query(
      `SELECT bookingID AS "bookingId", TO_CHAR(startTime, 'YYYY-MM-DD"T"HH24:MI:SS') AS "startTime",
              TO_CHAR(endTime, 'YYYY-MM-DD"T"HH24:MI:SS') AS "endTime",
              studentID AS "studentId", equipmentID AS "equipmentId", remindedAt
       FROM Booking
       WHERE endTime >= SYSTIMESTAMP
       ORDER BY startTime DESC`
    );
    res.json({ bookings: rows });
  });

  async function hasOverlap(conn, { equipmentId, startTime, endTime }) {
    const binds = {
      equipmentId: Number(equipmentId),
      startTime: new Date(startTime),
      endTime: new Date(endTime),
    };

    const result = await conn.execute(
      `SELECT COUNT(1) AS cnt
       FROM Booking
       WHERE equipmentID = :equipmentId
         AND startTime < :endTime
         AND endTime > :startTime`,
      binds
    );
    const cnt = result.rows?.[0]?.[0] ?? result.rows?.[0]?.CNT ?? 0;
    return Number(cnt) > 0;
  }

  app.post('/bookings', async (req, res) => {
    const { equipmentId, studentId, startTime, endTime } = req.body || {};
    if (!equipmentId || !studentId || !startTime || !endTime) {
      return res.status(400).json({ error: 'equipmentId, studentId, startTime, endTime required' });
    }

    const s = new Date(startTime);
    const e = new Date(endTime);
    if (!(s.getTime() < e.getTime())) return res.status(400).json({ error: 'endTime must be after startTime' });

    try {
      await transaction(async (conn) => {
        const memRows = await conn.execute(
          `SELECT expireDate FROM (
             SELECT studentID, expireDate,
                    ROW_NUMBER() OVER (PARTITION BY studentID ORDER BY expireDate DESC, memberID DESC) AS rn
             FROM Membership
           ) WHERE studentID = :studentId AND rn = 1`,
          { studentId: Number(studentId) }
        );
        if (!memRows.rows.length) {
          const err = new Error('no membership');
          err.code = 'NO_MEMBERSHIP';
          throw err;
        }
        const expireDate = memRows.rows[0][0];
        if (expireDate < new Date()) {
          const err = new Error('membership expired');
          err.code = 'MEMBERSHIP_EXPIRED';
          throw err;
        }

        const overlap = await hasOverlap(conn, { equipmentId, startTime, endTime });
        if (overlap) {
          const err = new Error('overlap');
          err.code = 'OVERLAP';
          throw err;
        }
        await conn.execute(
          `INSERT INTO Booking (startTime, endTime, studentID, equipmentID)
           VALUES (:startTime, :endTime, :studentId, :equipmentId)`,
          { startTime: s, endTime: e, studentId: Number(studentId), equipmentId: Number(equipmentId) },
          { autoCommit: false }
        );
      });
    } catch (e2) {
      if (e2.code === 'OVERLAP') return res.status(409).json({ error: 'time slot already taken' });
      if (e2.code === 'NO_MEMBERSHIP') return res.status(403).json({ error: 'membership required' });
      if (e2.code === 'MEMBERSHIP_EXPIRED') return res.status(403).json({ error: 'membership expired' });
      throw e2;
    }

    res.status(201).json({ ok: true });
  });

  app.delete('/bookings/:bookingId', async (req, res) => {
    const bookingId = Number(req.params.bookingId);
    const result = await execute('DELETE FROM Booking WHERE bookingID = :bookingId', { bookingId });
    if (!result.rowsAffected) return res.status(404).json({ error: 'not found' });
    res.status(204).send();
  });

  app.get('/equipment', async (req, res) => {
    const rows = await query(
      `SELECT equipmentID AS "equipmentId", name, administratorID AS "administratorId", status
       FROM Equipment ORDER BY equipmentID`
    );
    res.json({ equipment: rows });
  });

  app.post('/equipment', async (req, res) => {
    const { name, administratorId, status } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    await execute(
      `INSERT INTO Equipment (name, administratorID, status)
       VALUES (:name, :administratorId, :status)`,
      { name, administratorId: administratorId || null, status: status || 'AVAILABLE' }
    );
    res.status(201).json({ ok: true });
  });

  app.patch('/equipment/:equipmentId', async (req, res) => {
    const equipmentId = Number(req.params.equipmentId);
    const { name, administratorId, status } = req.body || {};
    const updates = [];
    const binds = { equipmentId };
    if (name !== undefined) {
      updates.push('name = :name');
      binds.name = name;
    }
    if (administratorId !== undefined) {
      updates.push('administratorID = :administratorId');
      binds.administratorId = administratorId;
    }
    if (status !== undefined) {
      updates.push('status = :status');
      binds.status = status;
    }
    if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
    const result = await execute(`UPDATE Equipment SET ${updates.join(', ')} WHERE equipmentID = :equipmentId`, binds);
    if (!result.rowsAffected) return res.status(404).json({ error: 'not found' });
    res.json({ equipmentId });
  });

  app.delete('/equipment/:equipmentId', async (req, res) => {
    const equipmentId = Number(req.params.equipmentId);
    const future = await query(
      `SELECT COUNT(1) AS "count" FROM Booking
       WHERE equipmentID = :equipmentId AND startTime > SYSTIMESTAMP`,
      { equipmentId }
    );
    if (Number(future[0]?.count || future[0]?.COUNT || 0) > 0) {
      return res.status(409).json({ error: 'active future bookings exist' });
    }
    const result = await execute('DELETE FROM Equipment WHERE equipmentID = :equipmentId', { equipmentId });
    if (!result.rowsAffected) return res.status(404).json({ error: 'not found' });
    res.status(204).send();
  });

  // ===========================
  // Notification Service
  // ===========================
  app.post('/notifications/send', async (req, res) => {
    const { recipientId, channels, type, subject, message } = req.body || {};
    if (!recipientId || !message) return res.status(400).json({ error: 'recipientId, message required' });

    const ch = Array.isArray(channels) && channels.length ? channels : ['email'];
    const recipient = String(recipientId);

    let studentId = null;
    let email = null;
    if (recipient.includes('@')) {
      email = recipient;
    } else {
      studentId = Number(recipient);
      if (!Number.isNaN(studentId)) {
        const rows = await query(`SELECT keycloakUserId FROM Student WHERE studentID = :studentId`, { studentId });
        const userId = rows[0]?.keycloakUserId || rows[0]?.KEYCLOAKUSERID || null;
        if (userId) {
          try {
            const kcUser = await kc.getUser(userId);
            email = kcUser?.email || '';
          } catch (e) {
            console.error('[notifications/send] failed to get keycloak user', { studentId, userId, message: e.message });
          }
        }
      }
    }

    const notifType = type ? String(type) : 'notification';
    const text = String(message);
    const subj = subject ? String(subject) : `Notification${type ? `: ${type}` : ''}`;

    for (const c of ch) {
      const channel = String(c);
      await createNotification({ studentId, type: notifType, message: text, channel, to: email });
      if (channel === 'email' && email) {
        await sendEmail({ smtp: config.smtp, to: email, subject: subj, text });
      }
    }

    res.status(201).json({ ok: true });
  });

  app.get('/notifications/status/:messageId', async (req, res) => {
    const notificationId = Number(req.params.messageId);
    const rows = await query(
      `SELECT notificationID AS "notificationId", status
       FROM Notification WHERE notificationID = :notificationId`,
      { notificationId }
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  });

  // =======================
  // Reporting Service
  // =======================
  app.get('/reports/membership-stats', async (req, res) => {
    const { startDate, endDate } = req.query;

    const activeRows = await query(`SELECT COUNT(1) AS cnt FROM Student WHERE status = 'ACTIVE'`);
    const blockedRows = await query(`SELECT COUNT(1) AS cnt FROM Student WHERE status = 'BLOCKED'`);
    const active = Number(activeRows[0]?.CNT ?? activeRows[0]?.cnt ?? 0);
    const blocked = Number(blockedRows[0]?.CNT ?? blockedRows[0]?.cnt ?? 0);

    let membershipsIssued = null;
    if (startDate || endDate) {
      const binds = { startDate: startDate || null, endDate: endDate || null };
      const issuedRows = await query(
        `SELECT COUNT(1) AS cnt
         FROM Membership
         WHERE (:startDate IS NULL OR TRUNC(issueDate) >= TO_DATE(:startDate, 'YYYY-MM-DD'))
           AND (:endDate IS NULL OR TRUNC(issueDate) <= TO_DATE(:endDate, 'YYYY-MM-DD'))`,
        binds
      );
      membershipsIssued = Number(issuedRows[0]?.CNT ?? issuedRows[0]?.cnt ?? 0);
    }

    res.json({
      active,
      blocked,
      total: active + blocked,
      startDate: startDate || null,
      endDate: endDate || null,
      membershipsIssued,
    });
  });

  app.get('/reports/equipment-usage', async (req, res) => {
    const rows = await query(
      `SELECT e.equipmentID AS "equipmentId", e.name,
              COUNT(b.bookingID) AS "bookingCount"
       FROM Equipment e
       LEFT JOIN Booking b ON b.equipmentID = e.equipmentID
       GROUP BY e.equipmentID, e.name
       ORDER BY "bookingCount" DESC, e.equipmentID`
    );
    res.json({ equipmentUsage: rows });
  });

  app.get('/reports/payments', async (req, res) => {
    const rows = await query(
      `SELECT paymentID AS "paymentId", TO_CHAR(paymentDate, 'YYYY-MM-DD') AS "paymentDate",
             transactionRef, amount, studentID AS "studentId"
      FROM Payment ORDER BY paymentDate DESC, paymentID DESC`
    );
    const totalRows = await query(`SELECT NVL(SUM(amount), 0) AS total FROM Payment`);
    const total = Number(totalRows[0]?.TOTAL ?? totalRows[0]?.total ?? 0);
    res.json({ payments: rows, total });
  });

  // --- Background job helpers (used by src/common/scheduler.js)
  async function sendBookingReminders() {
    const rows = await query(
      `SELECT b.bookingID AS "bookingId", b.studentID AS "studentId", s.keycloakUserId, e.name AS "equipmentName",
              b.startTime
       FROM Booking b
       JOIN Student s ON s.studentID = b.studentID
       JOIN Equipment e ON e.equipmentID = b.equipmentID
       WHERE b.remindedAt IS NULL
         AND b.startTime BETWEEN (SYSTIMESTAMP + INTERVAL '1' HOUR + INTERVAL '55' MINUTE)
                         AND (SYSTIMESTAMP + INTERVAL '2' HOUR + INTERVAL '5' MINUTE)`
    );
    for (const r of rows) {
      let email = '';
      try {
        const userId = r.keycloakUserId || r.KEYCLOAKUSERID;
        if (userId) {
          const kcUser = await kc.getUser(userId);
          email = kcUser?.email || '';
        }
      } catch (e) {
        console.error('[sendBookingReminders] failed to get keycloak user', { studentId: r.studentId, message: e.message });
      }
      if (!email) continue;
      const text = `Reminder: your booking for ${r.equipmentName} starts at ${r.startTime}.`;
      await createNotification({ studentId: Number(r.studentId), type: 'booking_reminder', message: text, channel: 'email', to: email });
      await sendEmail({ smtp: config.smtp, to: email, subject: 'Booking reminder', text });
      await execute(`UPDATE Booking SET remindedAt = SYSTIMESTAMP WHERE bookingID = :bookingId`, { bookingId: Number(r.bookingId) });
    }
  }

  async function sendRenewalReminders() {
    const rows = await query(
      `SELECT memberId, studentId, keycloakUserId, expireDate
       FROM (
         SELECT m.memberID AS memberId,
                m.studentID AS studentId,
                s.keycloakUserId,
                m.expireDate,
                m.renewalRemindedAt,
                ROW_NUMBER() OVER (PARTITION BY m.studentID ORDER BY m.issueDate DESC, m.memberID DESC) AS rn
         FROM Membership m
         JOIN Student s ON s.studentID = m.studentID
       )
       WHERE rn = 1
         AND renewalRemindedAt IS NULL
         AND expireDate BETWEEN (SYSDATE + 60) AND (SYSDATE + 62)`
    );
    for (const r of rows) {
      let email = '';
      try {
        const userId = r.keycloakUserId || r.KEYCLOAKUSERID;
        if (userId) {
          const kcUser = await kc.getUser(userId);
          email = kcUser?.email || '';
        }
      } catch (e) {
        console.error('[sendRenewalReminders] failed to get keycloak user', { studentId: r.studentId, message: e.message });
      }
      if (!email) continue;
      const exp = toIsoDate(new Date(r.expireDate));
      const text = `Your membership will expire on ${exp}. Please renew to avoid being blocked.`;
      await createNotification({ studentId: Number(r.studentId), type: 'renewal_reminder', message: text, channel: 'email', to: email });
      await sendEmail({ smtp: config.smtp, to: email, subject: 'Membership renewal reminder', text });
      await execute(`UPDATE Membership SET renewalRemindedAt = SYSDATE WHERE memberID = :memberId`, { memberId: Number(r.memberId) });
    }
  }

  async function blockExpiredMembers() {
    const toBlock = await query(
      `SELECT s.studentID AS "studentId", s.keycloakUserId
       FROM Student s
       JOIN (
         SELECT studentID, MAX(expireDate) AS maxExpire
         FROM Membership
         GROUP BY studentID
       ) mx ON mx.studentID = s.studentID
       WHERE s.status <> 'BLOCKED'
         AND mx.maxExpire < SYSDATE`
    );

    if (!toBlock.length) return;

    const binds = {};
    const ids = toBlock.map((r, i) => {
      const k = `id${i}`;
      binds[k] = Number(r.studentId);
      return `:${k}`;
    });

    await execute(`UPDATE Student SET status = 'BLOCKED' WHERE studentID IN (${ids.join(', ')})`, binds);

    // Disable Keycloak users (best-effort).
    if (kc) {
      for (const r of toBlock) {
        try {
          const userId = r.keycloakUserId || r.KEYCLOAKUSERID || null;
          if (userId) {
            await kc.setUserEnabled(String(userId), false);
          } else {
            const u = await kc.findUserByUsername(String(r.studentId));
            if (u?.id) await kc.setUserEnabled(String(u.id), false);
          }
        } catch (e) {
          console.error('Keycloak disable failed:', e.message);
        }
      }
    }
  }

  app.use((err, req, res, next) => {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'internal error' });
  });

  return {
    app,
    jobs: { sendBookingReminders, sendRenewalReminders, blockExpiredMembers },
  };
}

module.exports = { portalApp };

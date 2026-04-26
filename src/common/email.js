const nodemailer = require('nodemailer');

function canSend(smtp) {
  return Boolean(smtp && smtp.host && smtp.user && smtp.pass);
}

function makeTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port || (smtp.secure ? 465 : 587),
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass,
    },
  });
}

async function sendEmail({ smtp, to, subject, text }) {
  if (!canSend(smtp)) {
    // Dev fallback: log only.
    console.log('[email:dev]', { to, subject, text });
    return { messageId: `dev-${Date.now()}` };
  }

  const transport = makeTransport(smtp);
  const info = await transport.sendMail({
    from: smtp.from,
    to,
    subject,
    text,
  });
  return { messageId: info.messageId };
}

module.exports = { sendEmail };

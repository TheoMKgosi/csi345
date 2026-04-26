const cron = require('node-cron');

function startSchedulers({ portal }) {
  // Booking reminder: every minute.
  cron.schedule('* * * * *', async () => {
    try {
      await portal.sendBookingReminders();
    } catch (e) {
      console.error('booking reminder job failed', e.message);
    }
  });

  // Renewal reminders + auto-block: daily at 01:05.
  cron.schedule('5 1 * * *', async () => {
    try {
      await portal.sendRenewalReminders();
    } catch (e) {
      console.error('renewal reminder job failed', e.message);
    }

    try {
      await portal.blockExpiredMembers();
    } catch (e) {
      console.error('block expired job failed', e.message);
    }
  });
}

module.exports = { startSchedulers };

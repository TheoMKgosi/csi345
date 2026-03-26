const express = require('express');
const oracledb = require('oracledb');

const dbConfig = {
  user: "your_username",
  password: "your_password",
  connectString: "localhost/FREEPDB1" // e.g., "mydbmachine.example.com:1521/orclpdb1"
};

const app = express();

async function sqlHelpers(sql, bind = []) {
  try {
    const connection = await oracledb.getConnection(dbConfig)
    const result = await connection.execute(sql, bind, { autoCommit: true, outFormat: oracledb.OUT_FORMAT_OBJECT })
    return result.rows
  } catch (error) {
    onsole.error('Oracle Query Error:', err);
    throw err;
  } finally {
    if (connection) {
      await connection.close()
    }
  }
}

app.post('/login', (req, res) => {
  res.json({ message: "Hello" })
});

app.post('/register/validate', (req, res) => {
  res.json({ message: "Hello" })
});

app.get('/members/:studentId/status', (req, res) => {

});

app.post('/members/renew', (req, res) => {
  res.json({ message: "Hello" })
});

app.get('/cards/generate/:studentId', (req, res) => {
  res.json({ message: "Hello" })
});

app.get('/bookings', (req, res) => {
  const result = sqlHelpers("SELECT * from booking;")
  res.json({ boodking: result }).status(200)
});

app.post('/bookings', (req, res) => {
  res.json({ message: "Hello" })
});

app.delete('/bookings/:bookingId', (req, res) => {
  res.json({ message: "Hello" })
});

app.get('/equipment', (req, res) => {
  res.json({ message: "Hello" })
});

app.post('/equipment', (req, res) => {
  res.json({ message: "Hello" })
});

app.patch('/equipment/:equipmentId', (req, res) => {
  res.json({ message: "Hello" })
});

app.delete('/equipment/:equipmentId', (req, res) => {
  res.json({ message: "Hello" })
});

app.post('/notifications/send', (req, res) => {
  res.json({ message: "Hello" })
});

app.get('/notifications/status/:messageId', (req, res) => {
  res.json({ message: "Hello" })
});

app.get('/reports/membership-stats', (req, res) => {
  res.json({ message: "Hello" })
});

app.get('/reports/equipment-usage', (req, res) => {
  res.json({ message: "Hello" })
});

app.get('/reports/revenue', (req, res) => {
  res.json({ message: "Hello" })
});

app.listen(3000, function() {
  console.log('App listening on port 3000');
});

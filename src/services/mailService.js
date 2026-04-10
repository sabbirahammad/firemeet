const nodemailer = require('nodemailer');

function buildTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

async function sendOtpMail(email, code) {
  const transporter = buildTransporter();

  if (!transporter) {
    throw new Error('SMTP credentials are missing. Set SMTP_USER and SMTP_PASS in backend/.env');
  }

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'MyDating signup verification code',
    text: `Your MyDating verification code is ${code}. This code will expire in 10 minutes.`,
  });
}

module.exports = {
  sendOtpMail,
};

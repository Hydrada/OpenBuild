import nodemailer from "nodemailer";
import type { Mailer } from "./notify.js";

/** SMTP mailer from a URL such as smtps://user:pass@smtp.example.com:465 */
export function createSmtpMailer(url: string, from: string, log: (msg: string) => void = console.error): Mailer {
  const transport = nodemailer.createTransport(url);
  return async (to, subject, text) => {
    try {
      await transport.sendMail({ from, to, subject, text });
    } catch (e) {
      log(`Email to ${to} failed: ${(e as Error).message}`);
      throw e;
    }
  };
}

"use strict";

const EMAIL_GATEWAY_URL = "http://127.0.0.1:2525/api/email/send";
const REQUEST_TIMEOUT_MS = 30_000;

async function sendEmail({ to, subject, text }) {
  const payload = { to: [to], subject, text };
  let response;
  try {
    response = await fetch(EMAIL_GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Email gateway unreachable: ${describeError(error)}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body || body.success !== true) {
    const detail = body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(`Email gateway send failed: ${detail}`);
  }
  if (typeof body.messageId !== "string" || !body.messageId) {
    throw new Error("Email gateway succeeded without returning a message ID");
  }
  return { messageId: body.messageId };
}

function describeError(error) {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return "request timed out";
    return error.message;
  }
  return String(error);
}

module.exports = { sendEmail };

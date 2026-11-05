import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { computeAppIdHash, getFyersTokenFailureReason } from "@/server/providers/fyers/client";

// Unattended Fyers login via TOTP.
//
// Fyers disabled the refresh-token API for SEBI compliance, so a stored refresh
// token can no longer renew access tokens. The only way to get a fresh token
// without a human clicking through OAuth is to replay the login server-side:
//   send_login_otp -> verify_otp (TOTP) -> verify_pin -> /token (auth_code)
//   -> validate-authcode (access token)
//
// This uses ONE Fyers account (the deployment owner's) as the market-data
// source for the whole app. Market data is account-agnostic, so per-user broker
// connections aren't needed for quotes/history/option-chain.
//
// Verified against a live account during the Upstox->Fyers migration:
//  - login (vagator) service is on api-t2, the data/auth API on api-t1
//  - fy_id and pin are sent as PLAIN text (base64 is rejected: -1025 / Invalid PIN)
//  - the /token step returns HTTP 308 with auth_code inside the JSON `Url` field

const API = process.env.FYERS_API_URL || "https://api-t1.fyers.in/api/v3";
const ORIGIN = new URL(API).origin;
const VAGATOR = `${ORIGIN.replace("api-t1", "api-t2")}/vagator/v2`;
// Cache outside the project dir so writing it never triggers the dev watcher.
const CACHE_FILE = path.join(os.tmpdir(), "tradex-fyers-token.json");

interface TokenCache {
  accessToken: string;
  refreshToken: string | null;
  fetchedAt: number;
}

let memoryCache: TokenCache | null = null;
let inFlight: Promise<string | null> | null = null;

function totpConfigured(): boolean {
  return Boolean(
    process.env.FYERS_FY_ID &&
      process.env.FYERS_PIN &&
      process.env.FYERS_TOTP_SECRET &&
      process.env.FYERS_CLIENT_ID &&
      process.env.FYERS_SECRET_KEY,
  );
}

function base32Decode(b32: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of b32.replace(/=+$/, "").toUpperCase().replace(/\s/g, "")) {
    const v = alphabet.indexOf(c);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totpNow(secret: string, skew = 0): string {
  const key = base32Decode(secret);
  let counter = Math.floor(Date.now() / 1000 / 30) + skew;
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const h = crypto.createHmac("sha1", key).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code =
    ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  redirect: RequestRedirect = "follow",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(url, {
    method: "POST",
    redirect,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await r.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: r.status, json };
}

// Perform the full unattended login. Returns fresh tokens or null on failure.
export async function loginFyersViaTotp(): Promise<TokenCache | null> {
  if (!totpConfigured()) return null;

  const clientId = process.env.FYERS_CLIENT_ID as string; // e.g. X8VSZUU8YZ-200
  const secret = process.env.FYERS_SECRET_KEY as string;
  const fyId = process.env.FYERS_FY_ID as string;
  const pin = process.env.FYERS_PIN as string;
  const totpSecret = process.env.FYERS_TOTP_SECRET as string;
  const redirectUri = process.env.FYERS_REDIRECT_URL || "http://localhost:3000/api/broker/callback";
  const [appId, appType] = clientId.split("-");

  try {
    // 1) send_login_otp (fy_id is plain text)
    const otpRes = await postJson(`${VAGATOR}/send_login_otp`, { fy_id: fyId, app_id: "2" });
    const requestKey = otpRes.json.request_key as string | undefined;
    if (!requestKey) {
      console.warn("Fyers auto-login: send_login_otp failed", otpRes.status, otpRes.json.message);
      return null;
    }

    // 2) verify_otp (retry across the 30s boundary for clock skew)
    let verifiedKey: string | undefined;
    for (const skew of [0, -1, 1]) {
      const v = await postJson(`${VAGATOR}/verify_otp`, {
        request_key: requestKey,
        otp: totpNow(totpSecret, skew),
      });
      if (v.json.request_key) {
        verifiedKey = v.json.request_key as string;
        break;
      }
    }
    if (!verifiedKey) {
      console.warn("Fyers auto-login: TOTP verification failed");
      return null;
    }

    // 3) verify_pin (pin is plain text)
    const pinRes = await postJson(`${VAGATOR}/verify_pin`, {
      request_key: verifiedKey,
      identity_type: "pin",
      identifier: pin,
    });
    const loginToken = (pinRes.json.data as { access_token?: string } | undefined)?.access_token;
    if (!loginToken) {
      console.warn("Fyers auto-login: verify_pin failed", pinRes.status, pinRes.json.message);
      return null;
    }

    // 4) /token -> auth_code (HTTP 308 with auth_code in the JSON `Url` field)
    const tokenRes = await postJson(
      `${API}/token`,
      {
        fyers_id: fyId,
        app_id: appId,
        redirect_uri: redirectUri,
        appType,
        code_challenge: "",
        state: "auto",
        scope: "",
        nonce: "",
        response_type: "code",
        create_cookie: true,
      },
      { Authorization: `Bearer ${loginToken}` },
      "manual",
    );
    const redirectUrl = (tokenRes.json.Url || tokenRes.json.url) as string | undefined;
    const authCode = redirectUrl ? new URL(redirectUrl).searchParams.get("auth_code") : null;
    if (!authCode) {
      console.warn("Fyers auto-login: no auth_code from /token", tokenRes.status);
      return null;
    }

    // 5) validate-authcode -> access token
    const appIdHash = computeAppIdHash(clientId, secret);
    const finalRes = await postJson(`${API}/validate-authcode`, {
      grant_type: "authorization_code",
      appIdHash,
      code: authCode,
    });
    const accessToken = finalRes.json.access_token as string | undefined;
    if (!accessToken) {
      console.warn("Fyers auto-login: validate-authcode returned no token", finalRes.status);
      return null;
    }

    return {
      accessToken,
      refreshToken: (finalRes.json.refresh_token as string | undefined) ?? null,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    console.warn("Fyers auto-login error:", error);
    return null;
  }
}

// Fyers access tokens expire around 06:00 IST the next morning. Treat a cached
// token as fresh until the first 06:00 IST boundary after it was fetched.
function isFresh(cache: TokenCache): boolean {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const ist = new Date(cache.fetchedAt + IST_OFFSET);
  let expiry = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0, 0) - IST_OFFSET;
  if (expiry <= cache.fetchedAt) expiry += 24 * 60 * 60 * 1000;
  return Date.now() < expiry && !getFyersTokenFailureReason(cache.accessToken);
}

function readFileCache(): TokenCache | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as TokenCache;
  } catch {
    return null;
  }
}

function writeFileCache(cache: TokenCache): void {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch {
    // Non-fatal: a missing cache just means we re-login next cold start.
  }
}

// Returns a valid Fyers access token, logging in via TOTP when needed. Returns
// null when auto-login isn't configured (callers then fall back to sample data
// or a per-user OAuth token). Concurrent callers share a single login attempt.
export async function getFyersAccessToken(): Promise<string | null> {
  if (!totpConfigured()) return null;

  if (memoryCache && isFresh(memoryCache)) return memoryCache.accessToken;

  const fromFile = readFileCache();
  if (fromFile && isFresh(fromFile)) {
    memoryCache = fromFile;
    return fromFile.accessToken;
  }

  if (!inFlight) {
    inFlight = (async () => {
      try {
        const result = await loginFyersViaTotp();
        if (result) {
          memoryCache = result;
          writeFileCache(result);
          return result.accessToken;
        }
        return null;
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

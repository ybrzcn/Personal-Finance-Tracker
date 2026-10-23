import { isTauri } from "./platform";
import { t } from "./i18n";

/** Passkey yalnız tarayıcıda: masaüstü/mobil uygulamanın penceresi sunucunun alan adında çalışmaz. */
export const passkeySupported = !isTauri && typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";

const b64 = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const unb64 = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Tarayıcı hatalarını kullanıcı diline çevirir */
function passkeyError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return t("Passkey işlemi iptal edildi ya da süresi doldu.");
  if (name === "InvalidStateError") return t("Bu cihazdaki passkey zaten ekli.");
  if (name === "SecurityError") return t("Passkey bu adreste kullanılamıyor; sunucuya https ve alan adıyla bağlanın.");
  return t("Passkey kullanılamadı.");
}

export interface PasskeyCreateOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  algs: number[];
  excludeCredentials: string[];
}

export async function createPasskey(o: PasskeyCreateOptions) {
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        challenge: unb64(o.challenge),
        rp: o.rp,
        user: { id: unb64(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.algs.map((alg) => ({ type: "public-key" as const, alg })),
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        excludeCredentials: o.excludeCredentials.map((id) => ({ type: "public-key" as const, id: unb64(id) })),
        attestation: "none",
        timeout: 120_000,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw passkeyError(e);
  }
  const res = cred.response as AuthenticatorAttestationResponse;
  const key = typeof res.getPublicKey === "function" && typeof res.getAuthenticatorData === "function" && typeof res.getPublicKeyAlgorithm === "function" ? res.getPublicKey() : null;
  if (!key) throw t("Tarayıcı passkey'in açık anahtarını vermedi; tarayıcınızı güncelleyin.");
  return {
    id: cred.id,
    clientDataJSON: b64(res.clientDataJSON),
    authenticatorData: b64(res.getAuthenticatorData()),
    publicKey: b64(key),
    alg: res.getPublicKeyAlgorithm(),
  };
}

export async function getPasskey(challenge: string, rpId: string) {
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get({
      publicKey: { challenge: unb64(challenge), rpId, userVerification: "required", timeout: 120_000 },
    })) as PublicKeyCredential;
  } catch (e) {
    throw passkeyError(e);
  }
  const res = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    clientDataJSON: b64(res.clientDataJSON),
    authenticatorData: b64(res.authenticatorData),
    signature: b64(res.signature),
  };
}

/** Önerilen ad: işletim sistemi ve tarayıcı ("Mac · Safari") */
export function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [os, br].filter(Boolean).join(" · ") || "Passkey";
}

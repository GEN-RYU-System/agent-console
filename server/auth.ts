import { timingSafeEqual } from "node:crypto";

export interface Auth {
  isTokenValid(url: URL, authorization: string | undefined): boolean;
  isOriginAllowed(origin: string | undefined): boolean;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createAuth(token: string, port: number): Auth {
  const ownOrigin = `http://127.0.0.1:${port}`;
  return {
    isTokenValid(url, authorization) {
      const fromQuery = url.searchParams.get("t");
      if (fromQuery !== null && safeEqual(fromQuery, token)) return true;
      if (authorization?.startsWith("Bearer ")) return safeEqual(authorization.slice("Bearer ".length), token);
      return false;
    },
    isOriginAllowed(origin) {
      return origin === ownOrigin;
    },
  };
}

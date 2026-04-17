import * as vscode from "vscode";

const CLIENT_ID = "revamp-vscode";
const SECRET_KEY = "revamp.keycloak.tokens";

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  obtained_at: number;
}

async function issuerBase(): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("revamp");
  const v = cfg.get<string>("keycloakIssuer");
  if (!v) throw new Error("revamp.keycloakIssuer not configured (Settings → REVAMP)");
  return v.replace(/\/$/, "");
}

export async function startDeviceFlow(ctx: vscode.ExtensionContext): Promise<TokenBundle> {
  const base = await issuerBase();

  const initRes = await fetch(`${base}/protocol/openid-connect/auth/device`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: "openid profile email",
    }),
  });
  if (!initRes.ok) {
    throw new Error(`Device-auth init failed: ${initRes.status} ${await initRes.text()}`);
  }

  const init = (await initRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };

  vscode.env.openExternal(vscode.Uri.parse(init.verification_uri_complete));
  vscode.window.showInformationMessage(
    `Authorize REVAMP in your browser. Code: ${init.user_code}`,
  );

  const deadline = Date.now() + init.expires_in * 1000;
  const intervalMs = Math.max(1, init.interval) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const r = await fetch(`${base}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: init.device_code,
        client_id: CLIENT_ID,
      }),
    });

    if (r.status === 200) {
      const t = (await r.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      const bundle: TokenBundle = {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: Date.now() + t.expires_in * 1000,
        obtained_at: Date.now(),
      };
      await ctx.secrets.store(SECRET_KEY, JSON.stringify(bundle));
      return bundle;
    }

    if (r.status >= 400) {
      const err = (await r.json().catch(() => ({}))) as { error?: string };
      if (err.error === "authorization_pending") continue;
      if (err.error === "slow_down") {
        await new Promise((x) => setTimeout(x, intervalMs));
        continue;
      }
      throw new Error(`Device flow error: ${err.error ?? r.status}`);
    }
  }
  throw new Error("Device flow timed out");
}

export async function getAccessToken(ctx: vscode.ExtensionContext): Promise<string | null> {
  const raw = await ctx.secrets.get(SECRET_KEY);
  if (!raw) return null;
  const bundle = JSON.parse(raw) as TokenBundle;

  // Still fresh (more than 60 seconds remaining)
  if (bundle.expires_at - Date.now() > 60_000) return bundle.access_token;

  // Attempt silent refresh
  const base = await issuerBase().catch(() => null);
  if (!base) {
    await ctx.secrets.delete(SECRET_KEY);
    return null;
  }

  const r = await fetch(`${base}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: bundle.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  if (!r.ok) {
    await ctx.secrets.delete(SECRET_KEY);
    return null;
  }
  const t = (await r.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const fresh: TokenBundle = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + t.expires_in * 1000,
    obtained_at: Date.now(),
  };
  await ctx.secrets.store(SECRET_KEY, JSON.stringify(fresh));
  return fresh.access_token;
}

export async function signOut(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.secrets.delete(SECRET_KEY);
}

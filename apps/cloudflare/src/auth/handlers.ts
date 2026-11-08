import { AuthorizationError, authorizationErrorRedirect, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { SERVER_DISPLAY_NAME, type AccessLevel } from "@fiken-mcp/core";
import { isAllowedClient } from "../config.ts";
import { log } from "../log.ts";
import { consentPage } from "../ui/consent.ts";
import { messagePage } from "../ui/page.ts";
import { createPkce, exchangeCode, fetchUser, fikenAuthorizeUrl } from "./fiken-oauth.ts";
import { queueKeyFor, scopesFor, type GrantProps } from "./props.ts";

interface UpstreamData {
  verifier: string;
}

/** GET /authorize: validate the client, then show the consent page. Nothing goes to Fiken yet. */
export async function showConsent(request: Request, env: Env): Promise<Response> {
  return handleAuthErrors(async () => {
    // Refuse other clients before their metadata document is fetched.
    const clientId = new URL(request.url).searchParams.get("client_id") ?? "";
    if (!isAllowedClient(clientId)) return clientNotAllowed(clientId);

    const oauth = env.OAUTH_PROVIDER;
    const authRequest = await oauth.parseAuthRequest(request);
    if (!isAllowedClient(authRequest.clientId)) return clientNotAllowed(authRequest.clientId);

    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    return consentPage(details, consent.handle, consent.headers);
  });
}

/** POST /authorize: the user answered the consent page. Only now is `state` created and the user sent to Fiken. */
export async function submitConsent(request: Request, env: Env): Promise<Response> {
  return handleAuthErrors(async () => {
    const oauth = env.OAUTH_PROVIDER;
    const form = await request.formData();
    const field = form.get("handle");
    const handle = typeof field === "string" ? field : "";

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const access: AccessLevel = form.get("access") === "write" ? "write" : "read";
    const approved = await oauth.approveConsent(request, handle, { scope: scopesFor(access) });
    const pkce = await createPkce();
    const upstream = await oauth.beginUpstream(approved.request, {
      data: { verifier: pkce.verifier } satisfies UpstreamData,
      headers: approved.headers,
    });
    upstream.headers.set("Location", fikenAuthorizeUrl(env, upstream.state, pkce.challenge));
    log("consent_approved", { clientId: approved.request.clientId, access });
    return new Response(null, { status: 302, headers: upstream.headers });
  });
}

/** GET /callback: Fiken sends the user back. Exchange the code, identify the user, issue our grant. */
export async function finishSignIn(request: Request, env: Env): Promise<Response> {
  return handleAuthErrors(async () => {
    const oauth = env.OAUTH_PROVIDER;
    const upstream = await oauth.finishUpstream<UpstreamData>(request);
    const params = new URL(request.url).searchParams;
    const redirect = (location: string) => {
      upstream.headers.set("Location", location);
      return new Response(null, { status: 302, headers: upstream.headers });
    };

    const code = params.get("code");
    const state = params.get("state");
    if (params.get("error") || !code || !state) {
      log("fiken_sign_in_declined", { clientId: upstream.request.clientId, error: params.get("error") ?? "missing_code" });
      return redirect(authorizationErrorRedirect(upstream.request, "access_denied", "Innloggingen hos Fiken ble avbrutt."));
    }

    let props: GrantProps;
    try {
      const fiken = await exchangeCode(env, code, state, upstream.data.verifier);
      const user = await fetchUser(fiken.accessToken);
      props = { queueKey: await queueKeyFor(user.email, env.FIKEN_CLIENT_SECRET), fiken };
    } catch (error) {
      // Our own messages only: a parse error could quote the response body, which holds tokens.
      const reason = error instanceof Error && error.message.startsWith("Fiken ") ? error.message : error instanceof Error ? error.name : "unknown";
      log("fiken_sign_in_failed", { clientId: upstream.request.clientId, error: reason });
      return redirect(authorizationErrorRedirect(upstream.request, "server_error", "Innloggingen hos Fiken feilet. Prøv igjen."));
    }

    const { redirectTo } = await oauth.completeAuthorization({
      request: upstream.request,
      userId: props.queueKey,
      metadata: {},
      scope: upstream.request.scope,
      props,
    });
    log("grant_issued", { clientId: upstream.request.clientId, scope: upstream.request.scope.join(" ") });
    return redirect(redirectTo);
  });
}

async function handleAuthErrors(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      log("authorization_error", { code: error.code, description: error.description });
      return messagePage(
        400,
        "Tilkoblingen kunne ikke fullføres",
        "Siden kan være utløpt, allerede brukt eller åpnet i en annen nettleser. Start tilkoblingen på nytt fra Claude eller ChatGPT.",
        error.description,
      );
    }
    if (error instanceof CimdFetchError) {
      log("cimd_fetch_failed", { reason: error.message });
      return messagePage(502, "Appen kunne ikke verifiseres", "Vi fikk ikke hentet opplysningene om appen. Prøv igjen om litt.");
    }
    throw error;
  }
}

function clientNotAllowed(clientId: string): Response {
  log("client_not_allowed", { clientId: clientId.slice(0, 200) });
  return messagePage(403, "Denne appen kan ikke kobles til", `${SERVER_DISPLAY_NAME} kan foreløpig bare brukes fra Claude og ChatGPT.`);
}

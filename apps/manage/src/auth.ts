/* Verify signed Cloudflare Access JWT before serving any asset or API route. */
export interface Env {
  ASSETS: { fetch(r: Request): Promise<Response> };
  ACCESS_TEAM_DOMAIN: string; ACCESS_AUDIENCE: string; ACCESS_ALLOWED_EMAILS: string;
  GITHUB_API_TOKEN?: string; GITHUB_REPO: string; GITHUB_ENVIRONMENT: string;
  CLOUDFLARE_API_TOKEN?: string; CLOUDFLARE_ACCOUNT_ID?: string;
  GCP_PROJECT_ID?: string; GCP_REGION?: string; GCP_WIF_AUDIENCE?: string;
  GCP_IMPERSONATE_SERVICE_ACCOUNT?: string;
  SENTRY_ORG?: string; SENTRY_API_TOKEN?: string;
}
export type Identity = { email: string; jwt: string };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {status,headers:{
    "Content-Type":"application/json;charset=utf-8",
    "Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
  }});
}
export function failure(status: number, code: string, message: string): Response {
  return json({error:code,message},status);
}
const cached = new Map<string,{key:CryptoKey;expires:number}>();
function decode(part: string): Uint8Array {
  const raw=part.replace(/-/g,"+").replace(/_/g,"/");
  return Uint8Array.from(atob(raw+"=".repeat((4-raw.length%4)%4)),c=>c.charCodeAt(0));
}
function jwtJson(part: string): Record<string,unknown> {
  try { return JSON.parse(new TextDecoder().decode(decode(part))) as Record<string,unknown>; }
  catch { throw new ApiError(401,"ACCESS_INVALID","Sessão Access inválida"); }
}
export async function verifyAccess(request:Request,env:Env):Promise<Identity> {
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN||"") ||
      !/^[\w-]{20,128}$/.test(env.ACCESS_AUDIENCE||"") || !env.ACCESS_ALLOWED_EMAILS)
    throw new ApiError(503,"ACCESS_SETUP","Configure Cloudflare Access e a allowlist");
  const jwt=request.headers.get("Cf-Access-Jwt-Assertion") ||
    request.headers.get("Cookie")?.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!jwt) throw new ApiError(401,"ACCESS_REQUIRED","Login Cloudflare Access necessário");
  const parts=jwt.split(".");
  if (parts.length!==3) throw new ApiError(401,"ACCESS_INVALID","JWT inválido");
  const header=jwtJson(parts[0]),payload=jwtJson(parts[1]),now=Date.now()/1000;
  const issuer="https://"+env.ACCESS_TEAM_DOMAIN;
  if (header.alg!=="RS256" || typeof header.kid!=="string" || payload.iss!==issuer ||
      !(Array.isArray(payload.aud)?payload.aud:[payload.aud]).includes(env.ACCESS_AUDIENCE) ||
      typeof payload.exp!=="number" || payload.exp<=now ||
      (typeof payload.nbf==="number" && payload.nbf>now+30))
    throw new ApiError(401,"ACCESS_CLAIMS","Token Access inválido ou expirado");
  let allow:string[]=[];
  try {const parsed:unknown=JSON.parse(env.ACCESS_ALLOWED_EMAILS);
    if (Array.isArray(parsed)) allow=parsed.filter((x):x is string=>typeof x==="string");
  } catch {allow=env.ACCESS_ALLOWED_EMAILS.split(",");}
  const email=typeof payload.email==="string"?payload.email.toLowerCase():"";
  if (!email || !allow.map(x=>x.trim().toLowerCase()).includes(email))
    throw new ApiError(403,"ACCESS_DENIED","Conta não autorizada");
  const keyId=env.ACCESS_TEAM_DOMAIN+":"+header.kid;
  let entry=cached.get(keyId);
  if (!entry || entry.expires<Date.now()) {
    const result=await fetch(issuer+"/cdn-cgi/access/certs",{
      redirect:"manual",signal:AbortSignal.timeout(6000),
    });
    if (!result.ok) throw new ApiError(503,"ACCESS_CERTS","Chaves Access indisponíveis");
    const certs=await result.json() as {keys?:Array<JsonWebKey & {kid?:string}>};
    const jwk=certs.keys?.find(k=>k.kid===header.kid && k.kty==="RSA");
    if (!jwk) throw new ApiError(401,"ACCESS_KEY","Chave Access não encontrada");
    const key=await crypto.subtle.importKey("jwk",jwk,
      {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    entry={key,expires:Date.now()+10*60_000};
    if (cached.size>8) cached.clear();
    cached.set(keyId,entry);
  }
  const ok=await crypto.subtle.verify("RSASSA-PKCS1-v1_5",entry.key,
    decode(parts[2]) as BufferSource,new TextEncoder().encode(parts[0]+"."+parts[1]));
  if (!ok) throw new ApiError(401,"ACCESS_SIGNATURE","Assinatura JWT inválida");
  return {email,jwt};
}
export async function bodyJson<T>(request:Request,max=120_000):Promise<T> {
  if (request.headers.get("Content-Type")?.split(";")[0]!=="application/json")
    throw new ApiError(415,"CONTENT_TYPE","Use application/json");
  if (Number(request.headers.get("Content-Length")||0)>max)
    throw new ApiError(413,"BODY_LIMIT","Corpo muito grande");
  const text=await request.text();
  if(text.length>max)throw new ApiError(413,"BODY_LIMIT","Corpo muito grande");
  try{return JSON.parse(text) as T;}catch{throw new ApiError(400,"JSON","JSON inválido");}
}
export function requireOrigin(request:Request):void{
  if(request.headers.get("Origin")!==new URL(request.url).origin)
    throw new ApiError(403,"CSRF","Origem não permitida");
}
export function redact(value:unknown):string {
  return (typeof value==="string"?value:JSON.stringify(value)||"").slice(0,100_000)
    .replace(/(bearer\s+)\S+/gi,"$1[redacted]")
    .replace(/((?:password|token|secret|authorization|cookie)\s*[:=]\s*)[^\s,;"']+/gi,"$1[redacted]")
    .replace(/https?:\/\/[^\s"']+\?[^\s"']+/gi,"[URL privada]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g,"[JWT omitted]");
}

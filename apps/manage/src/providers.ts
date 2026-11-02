import {ApiError,redact} from "./auth";
import type {Env,Identity} from "./auth";

export const WORKFLOW_INPUTS:Record<string,Record<string,string[]>>={
  "gcp-deploy.yml":{
    action:["release","build","jobs-deploy","migrate","deploy","scheduler","cleanup"],
    migration_mode:["plan","apply","diagnose"],
    migration_database:["unselected","initial-empty","existing-with-backup"],
    migration_backup_prefix:[],
  },
  "cloudflare-setup.yml":{mode:["plan","apply"]},
  "gcp-health.yml":{},"deploy-worker.yml":{},
  "gcp-migrate.yml":{migration_mode:["plan","apply","diagnose"],migration_database:["unselected","initial-empty","existing-with-backup"],migration_backup_prefix:[]},"gcp-validation.yml":{},
  "icloud-validation.yml":{},"backend-smoke.yml":{},
};
export async function provider(url:string,token:string,init:RequestInit={}):Promise<unknown>{
  const headers=new Headers(init.headers);
  headers.set("Accept","application/json");
  headers.set("Content-Type","application/json");
  if(token)headers.set("Authorization","Bearer "+token);
  const response=await fetch(url,{...init,headers,redirect:"manual",
    signal:AbortSignal.timeout(12000)});
  if(!response.ok)
    throw new ApiError(response.status===401||response.status===403?503:502,
      "PROVIDER_"+response.status,"Provedor recusou a operação (HTTP "+response.status+")");
  if(response.status===204)return {ok:true};
  if(Number(response.headers.get("Content-Length")||0)>2_000_000)
    throw new ApiError(502,"RESPONSE_SIZE","Resposta maior que 2 MB");
  const text=await response.text();
  if(text.length>2_000_000)throw new ApiError(502,"RESPONSE_SIZE","Resposta muito grande");
  try{return JSON.parse(text);}catch{throw new ApiError(502,"RESPONSE_JSON","Resposta externa inválida");}
}
export function gh(env:Env,path:string,method="GET",payload?:unknown):Promise<unknown>{
  if(!env.GITHUB_API_TOKEN)throw new ApiError(503,"GITHUB_TOKEN","Configure GITHUB_API_TOKEN");
  const repo=env.GITHUB_REPO||"rodkisten/photointel";
  if(!/^[\w-]+\/[\w.-]+$/.test(repo))throw new ApiError(503,"GITHUB_REPO","Repositório inválido");
  return provider("https://api.github.com/repos/"+repo+path,env.GITHUB_API_TOKEN,{
    method,headers:{"X-GitHub-Api-Version":"2022-11-28",
      "Accept":"application/vnd.github+json"},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)}),
  });
}
export function cf(env:Env,path:string,method="GET",payload?:unknown):Promise<unknown>{
  if(!env.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID||""))
    throw new ApiError(503,"CF_TOKEN","Configure Cloudflare account ID e API token");
  return provider("https://api.cloudflare.com/client/v4/accounts/"+env.CLOUDFLARE_ACCOUNT_ID+path,
    env.CLOUDFLARE_API_TOKEN,{method,
      ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
}
export function configPath(env:Env):string{
  return "/environments/"+encodeURIComponent(env.GITHUB_ENVIRONMENT||"production")+
    "/variables/GCP_CONFIG_ENV";
}
export async function digest(raw:string):Promise<string>{
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
}
export async function readConfig(env:Env):Promise<{value:string;version:string;updated_at?:string}>{
  const variable=await gh(env,configPath(env)) as {value?:string;updated_at?:string};
  if(typeof variable.value!=="string")
    throw new ApiError(502,"GCP_CONFIG_ENV","Variável production/GCP_CONFIG_ENV não encontrada");
  return {value:variable.value,version:await digest(variable.value),updated_at:variable.updated_at};
}
export function validateConfig(value:string):void{
  if(!value.trim() || value.length>120_000 || value.includes("\0"))
    throw new ApiError(422,"CONFIG_SIZE","Valor precisa ter de 1 a 120.000 caracteres");
  if(/(?:github_pat_|ghp_|-----BEGIN PRIVATE KEY-----)/.test(value))
    throw new ApiError(422,"INLINE_SECRET","Guarde credenciais no Secret Manager");
  if(value.trim().startsWith("{")){
    let config:unknown;
    try{config=JSON.parse(value);}catch{throw new ApiError(422,"CONFIG_JSON","JSON inválido");}
    if(!config || typeof config!=="object" || Array.isArray(config))
      throw new ApiError(422,"CONFIG_JSON","Esperado objeto JSON");
    const data=config as Record<string,unknown>;
    if(data.project_id!=="photointel" || typeof data.region!=="string" ||
      !data.secrets || typeof data.secrets!=="object" || Array.isArray(data.secrets))
      throw new ApiError(422,"CONFIG_SCHEMA","Projeto, região ou referências Secret Manager inválidas");
  }else{
    if(!/^\s*PROJECT_ID\s*=\s*photointel\s*$/m.test(value) ||
       !/^\s*REGION\s*=/m.test(value))
      throw new ApiError(422,"CONFIG_ENV","O .env precisa conter PROJECT_ID=photointel e REGION");
  }
}
export async function gcpToken(env:Env,identity:Identity):Promise<string>{
  if(!env.GCP_WIF_AUDIENCE)
    throw new ApiError(503,"GCP_WIF","Configure GCP_WIF_AUDIENCE para consultar Google Cloud");
  if(!/^\/\/iam.googleapis.com\/projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[\w-]+\/providers\/[\w-]+$/.test(env.GCP_WIF_AUDIENCE))
    throw new ApiError(503,"GCP_WIF","Audiência WIF inválida");
  const token=await provider("https://sts.googleapis.com/v1/token","",{
    method:"POST",
    body:JSON.stringify({
      audience:env.GCP_WIF_AUDIENCE,
      grantType:"urn:ietf:params:oauth:grant-type:token-exchange",
      requestedTokenType:"urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType:"urn:ietf:params:oauth:token-type:jwt",
      subjectToken:identity.jwt,
      scope:"https://www.googleapis.com/auth/cloud-platform",
    }),
  }) as {access_token?:string};
  if(!token.access_token)throw new ApiError(503,"GCP_STS","Federação OIDC recusada");
  const account=env.GCP_IMPERSONATE_SERVICE_ACCOUNT;
  if(!account)return token.access_token;
  if(!/^[a-z][\w-]{2,70}@[a-z][\w-]{4,60}\.iam\.gserviceaccount\.com$/.test(account))
    throw new ApiError(503,"GCP_SA","Conta de serviço inválida");
  const result=await provider("https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/"+
    encodeURIComponent(account)+":generateAccessToken",token.access_token,{
      method:"POST",body:JSON.stringify({
        scope:["https://www.googleapis.com/auth/cloud-platform"],lifetime:"600s",
      }),
    }) as {accessToken?:string};
  if(!result.accessToken)throw new ApiError(503,"GCP_SA","Impersonação de conta não autorizada");
  return result.accessToken;
}
export async function gcp(env:Env,identity:Identity,url:string,body?:unknown):Promise<unknown>{
  const token=await gcpToken(env,identity);
  return provider(url,token,body===undefined?{}:{method:"POST",body:JSON.stringify(body)});
}
export function gcpBase(env:Env):string{
  const project=env.GCP_PROJECT_ID||"photointel",region=env.GCP_REGION||"us-central1";
  if(project!=="photointel" || !/^[a-z]{2,20}-[a-z0-9-]{2,40}[0-9]$/.test(region))
    throw new ApiError(503,"GCP_SCOPE","Projeto/região fora do escopo do PhotoIntel");
  return "https://run.googleapis.com/v2/projects/"+project+"/locations/"+region;
}
export function logsExplorer(env:Env,correlation:string):string{
  const query='(resource.type="cloud_run_job" OR resource.type="cloud_run_revision") AND SEARCH("'+correlation+'")';
  return "https://console.cloud.google.com/logs/query;query="+encodeURIComponent(query)+
    ";duration=P7D?project="+(env.GCP_PROJECT_ID||"photointel");
}
export function mapCloudLogs(items:unknown):Array<Record<string,unknown>>{
  if(!Array.isArray(items))return [];
  return items.slice(0,70).map((e:any)=>({
    timestamp:e.timestamp,severity:e.severity,resource:e.resource?.type,
    service:e.resource?.labels?.service_name||e.resource?.labels?.job_name,
    message:redact(e.jsonPayload||e.textPayload||{}).slice(0,10000),insertId:e.insertId,
  }));
}

import {ApiError, failure, json, requireOrigin, verifyAccess} from "./auth";
import type {Env} from "./auth";
import {api} from "./api";

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(request.method==="OPTIONS")return failure(405,"CORS","CORS desabilitado");
    try {
      const identity=await verifyAccess(request,env);
      if(request.method!=="GET" && request.method!=="HEAD")requireOrigin(request);
      if(path.startsWith("/api/"))return await api(request,env,identity);
      if(!["GET","HEAD"].includes(request.method))
        return failure(405,"METHOD","Método não permitido");
      const response=await env.ASSETS.fetch(request);
      const headers=new Headers(response.headers);
      headers.set("Cache-Control",path==="/"||path.endsWith(".html")?"no-store":"public,max-age=3600");
      headers.set("Referrer-Policy","no-referrer");
      headers.set("X-Frame-Options","DENY");
      headers.set("X-Content-Type-Options","nosniff");
      headers.set("Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
      return new Response(response.body,{status:response.status,headers});
    }catch(e){
      if(e instanceof ApiError)return failure(e.status,e.code,e.message);
      console.error(JSON.stringify({event:"manage_request_failed",
        kind:e instanceof Error?e.name:"UnknownError",route:path.startsWith("/api/")?"api":"asset"}));
      return json({error:"UPSTREAM_FAILURE",message:"Falha na integração. Verifique credenciais e permissões do provedor."},502);
    }
  },
};
